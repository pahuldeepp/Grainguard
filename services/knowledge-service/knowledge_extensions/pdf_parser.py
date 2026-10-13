"""Bounded PDF text extraction and deterministic canonical chunking."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re
from threading import Lock
from uuid import NAMESPACE_URL, uuid5

import pypdfium2 as pdfium

from .outline import DocumentOutline, InvalidOutline, ParsedBlock, build_outline


MAX_PDF_BYTES = 25 * 1024 * 1024
MAX_PDF_PAGES = 250
MAX_EXTRACTED_CHARS = 2_000_000
CHUNK_TARGET_CHARS = 2400
CHUNK_OVERLAP_CHARS = 280
_HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$")
_PDFIUM_LOCK = Lock()


class PdfParseError(ValueError):
    """PDF is unsupported, malformed, too large, or has no extractable text."""


@dataclass(frozen=True, slots=True)
class CanonicalChunk:
    chunk_id: str
    ordinal: int
    content: str
    content_sha256: str
    page_start: int
    page_end: int
    heading_path: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ParsedPdf:
    tenant_id: str
    document_id: str
    document_version: int
    source_sha256: str
    chunks: tuple[CanonicalChunk, ...]
    outline: DocumentOutline


def _normalise(text: str) -> str:
    text = text.replace("\u00ad", "").replace("\x00", "")
    lines = [re.sub(r"[\t\u00a0 ]+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line).strip()


def _split_text(text: str, target: int = CHUNK_TARGET_CHARS) -> list[str]:
    if len(text) <= target:
        return [text] if text else []
    parts: list[str] = []
    cursor = 0
    while cursor < len(text):
        end = min(cursor + target, len(text))
        if end < len(text):
            boundary = max(text.rfind("\n", cursor, end), text.rfind(". ", cursor, end))
            if boundary > cursor + target // 2:
                end = boundary + (1 if text[boundary] == "\n" else 2)
        piece = text[cursor:end].strip()
        if piece:
            parts.append(piece)
        if end >= len(text):
            break
        cursor = max(end - CHUNK_OVERLAP_CHARS, cursor + 1)
    return parts


def _looks_like_heading(lines: list[str], index: int) -> tuple[int, str] | None:
    line = lines[index]
    markdown = _HEADING.match(line)
    if markdown:
        title = markdown.group(2).strip()
        return (min(len(markdown.group(1)), 6), title) if title else None
    candidate = line.strip()
    if (len(candidate) <= 80 and 1 <= len(candidate.split()) <= 6
            and (candidate.isupper() or all(word[0].isupper() for word in candidate.split()))
            and not candidate.endswith((".", ",", ";", ":", "?", "!"))
            and (index == 0 or not lines[index - 1].strip())
            and index + 1 < len(lines) and len(lines[index + 1].split()) >= 5
            and lines[index + 1].strip()[:1].isupper()
            and any(character.isalpha() for character in candidate)):
        return (1, candidate)
    return None


def _parse_pdf_unlocked(
    data: bytes, *, tenant_id: str, document_id: str, document_version: int,
    max_pages: int = MAX_PDF_PAGES, ocr=None,
) -> ParsedPdf:
    """Extract a text-layer PDF into canonical chunks plus a PageIndex-style outline.

    OCR is optional and injected only by the sandbox worker. API callers do
    not execute OCR; image-only pages fail closed unless it is enabled.
    """
    if not isinstance(data, bytes) or not 8 <= len(data) <= MAX_PDF_BYTES or not data.startswith(b"%PDF-"):
        raise PdfParseError("input is not a bounded PDF file")
    if type(max_pages) is not int or not 1 <= max_pages <= MAX_PDF_PAGES:
        raise PdfParseError("page limit is invalid")
    try:
        document = pdfium.PdfDocument(data)
    except Exception as exc:
        raise PdfParseError("PDF could not be opened") from exc
    pages: list[str] = []
    try:
        page_count = len(document)
        if page_count < 1 or page_count > max_pages:
            raise PdfParseError("PDF page count is outside the configured limit")
        total_chars = 0
        ocr_pages = 0
        for page_index in range(page_count):
            page = document[page_index]
            textpage = None
            try:
                textpage = page.get_textpage()
                text = _normalise(textpage.get_text_range())
                if ocr is not None and len(text) < 40:
                    ocr_pages += 1
                    if ocr_pages > 20:
                        raise PdfParseError("PDF exceeds the 20-page OCR limit")
                    extracted = _normalise(ocr(page))
                    if len(extracted) > len(text):
                        text = extracted
            finally:
                if textpage is not None:
                    textpage.close()
                page.close()
            total_chars += len(text)
            if total_chars > MAX_EXTRACTED_CHARS:
                raise PdfParseError("extracted PDF text exceeds the configured limit")
            pages.append(text)
    except PdfParseError:
        raise
    except Exception as exc:
        raise PdfParseError("PDF text extraction failed") from exc
    finally:
        document.close()

    if not any(pages):
        raise PdfParseError("PDF has no extractable text; OCR is not enabled")
    source_sha256 = hashlib.sha256(data).hexdigest()
    blocks: list[ParsedBlock] = []
    chunks: list[CanonicalChunk] = []
    heading_path: list[tuple[int,str]] = []

    def emit(content: str, page: int) -> None:
        content = _normalise(content)
        for piece in _split_text(content):
            if len(chunks) >= 2000:
                raise PdfParseError("PDF exceeds the canonical passage limit")
            ordinal = len(chunks)
            digest = hashlib.sha256(piece.encode("utf-8")).hexdigest()
            chunk_id = str(uuid5(NAMESPACE_URL,
                                 f"{tenant_id}:{document_id}:{document_version}:{ordinal}:{digest}"))
            chunk = CanonicalChunk(chunk_id, ordinal, piece, digest, page, page, tuple(title for _,title in heading_path))
            chunks.append(chunk)
            blocks.append(ParsedBlock("chunk", piece, page, page, chunk_id=chunk_id))

    for page_no, page_text in enumerate(pages, start=1):
        lines = page_text.splitlines()
        accumulated: list[str] = []
        for line_no, line in enumerate(lines):
            found = _looks_like_heading(lines, line_no)
            if found:
                emit("\n".join(accumulated), page_no)
                accumulated.clear()
                level, title = found
                while heading_path and heading_path[-1][0] >= level:
                    heading_path.pop()
                heading_path.append((level,title))
                blocks.append(ParsedBlock("heading", title, page_no, page_no,
                                          heading_level=level))
                accumulated.append(title)
            else:
                accumulated.append(line)
        emit("\n".join(accumulated), page_no)

    if not chunks:
        raise PdfParseError("PDF produced no canonical text chunks")
    try:
        outline = build_outline(tenant_id=tenant_id, document_id=document_id,
                                document_version=document_version, blocks=blocks)
    except InvalidOutline as exc:
        raise PdfParseError("PDF produced an invalid outline") from exc
    return ParsedPdf(tenant_id, document_id, document_version, source_sha256,
                     tuple(chunks), outline)


def parse_pdf(
    data: bytes, *, tenant_id: str, document_id: str, document_version: int,
    max_pages: int = MAX_PDF_PAGES, ocr=None,
) -> ParsedPdf:
    """Serialize PDFium access, which is not safe for concurrent calls."""
    with _PDFIUM_LOCK:
        return _parse_pdf_unlocked(data, tenant_id=tenant_id, document_id=document_id,
                                   document_version=document_version, max_pages=max_pages, ocr=ocr)
