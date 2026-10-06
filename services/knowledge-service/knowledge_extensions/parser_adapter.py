"""Strict adapter from parser output to a synthetic I7 document outline.

Document/tenant/version identity is supplied by the trusted caller. Parser output
may refer only to canonical chunk IDs already stored by the owning service.
"""

from __future__ import annotations

import json
from typing import Any

from .outline import DocumentOutline, InvalidOutline, ParsedBlock, build_outline
from .outline_store import save_outline


class InvalidParserOutput(InvalidOutline):
    """Parser output does not match the accepted structured-block contract."""


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise InvalidParserOutput("duplicate JSON field")
        result[key] = value
    return result


def parse_parser_output(
    raw: str | bytes, *, tenant_id: str, expected_document_id: str,
    expected_document_version: int, canonical_chunk_ids: set[str],
) -> DocumentOutline:
    """Validate structured parser blocks and build an outline for trusted identity."""
    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        if not isinstance(text, str) or len(text.encode("utf-8")) > 262_144:
            raise InvalidParserOutput("parser output exceeds size limit")
        payload = json.loads(text, object_pairs_hook=_unique_object)
    except InvalidParserOutput:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, RecursionError) as exc:
        raise InvalidParserOutput("parser output must be UTF-8 JSON") from exc
    if not isinstance(payload, dict) or set(payload) != {
        "schema_version", "document_id", "document_version", "blocks"
    }:
        raise InvalidParserOutput("parser envelope fields are invalid")
    if (type(payload["schema_version"]) is not int or payload["schema_version"] != 1
            or payload["document_id"] != expected_document_id
            or type(payload["document_version"]) is not int
            or payload["document_version"] != expected_document_version):
        raise InvalidParserOutput("parser output document identity/version mismatch")
    if not isinstance(payload["blocks"], list) or len(payload["blocks"]) > 500:
        raise InvalidParserOutput("parser block count is invalid")

    blocks: list[ParsedBlock] = []
    for item in payload["blocks"]:
        if not isinstance(item, dict) or not isinstance(item.get("kind"), str):
            raise InvalidParserOutput("parser block is invalid")
        kind = item["kind"]
        expected = ({"kind", "text", "page_start", "page_end", "heading_level"}
                    if kind == "heading" else
                    {"kind", "text", "page_start", "page_end", "chunk_id"}
                    if kind == "chunk" else None)
        if expected is None or set(item) != expected:
            raise InvalidParserOutput("parser block fields are invalid")
        if not isinstance(item["text"], str) or len(item["text"]) > 10_000:
            raise InvalidParserOutput("parser block text is invalid")
        if type(item["page_start"]) is not int or type(item["page_end"]) is not int:
            raise InvalidParserOutput("parser page range is invalid")
        if kind == "heading":
            blocks.append(ParsedBlock("heading", item["text"], item["page_start"],
                                      item["page_end"], heading_level=item["heading_level"]))
        else:
            chunk_id = item["chunk_id"]
            if not isinstance(chunk_id, str) or chunk_id not in canonical_chunk_ids:
                raise InvalidParserOutput("parser chunk does not match canonical stored chunks")
            blocks.append(ParsedBlock("chunk", item["text"], item["page_start"],
                                      item["page_end"], chunk_id=chunk_id))
    try:
        outline = build_outline(
            tenant_id=tenant_id,
            document_id=expected_document_id,
            document_version=expected_document_version,
            blocks=blocks,
        )
        if set(outline.chunk_ids)!=canonical_chunk_ids:
            raise InvalidParserOutput("outline must include every canonical chunk")
        return outline
    except InvalidOutline as exc:
        raise InvalidParserOutput(str(exc)) from exc


def persist_parser_output(
    connection: Any, raw: str | bytes, *, tenant_id: str, expected_document_id: str,
    expected_document_version: int, canonical_chunk_ids: set[str], source_sha256: str,
) -> DocumentOutline:
    """Parse untrusted extractor output, then persist its projection transactionally.

    Tenant, document/version, source hash and canonical chunk IDs must come from
    the authenticated source-document service, never from parser output.
    """
    outline = parse_parser_output(
        raw, tenant_id=tenant_id, expected_document_id=expected_document_id,
        expected_document_version=expected_document_version,
        canonical_chunk_ids=canonical_chunk_ids,
    )
    save_outline(connection, tenant_id=tenant_id, outline=outline, source_sha256=source_sha256)
    return outline
