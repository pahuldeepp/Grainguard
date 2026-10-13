"""Deterministic hierarchical document outline helpers for PageIndex-style RAG."""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from uuid import NAMESPACE_URL, uuid5


_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")


class InvalidOutline(ValueError):
    """Parsed document structure cannot form a safe outline."""


@dataclass(frozen=True, slots=True)
class ParsedBlock:
    kind: str
    text: str
    page_start: int
    page_end: int
    chunk_id: str | None = None
    heading_level: int | None = None


@dataclass(slots=True)
class OutlineNode:
    node_id: str
    title: str
    level: int
    page_start: int
    page_end: int
    chunk_ids: list[str] = field(default_factory=list)
    children: list["OutlineNode"] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class DocumentOutline:
    tenant_id: str
    document_id: str
    document_version: int
    roots: tuple[OutlineNode, ...]
    chunk_ids: tuple[str, ...]
    citations: tuple["ChunkCitation", ...]


@dataclass(frozen=True, slots=True)
class ChunkCitation:
    tenant_id: str
    document_id: str
    document_version: int
    chunk_id: str
    page_start: int
    page_end: int
    heading_path: tuple[str, ...]


def _valid_uuid(value: str) -> bool:
    return isinstance(value, str) and bool(_UUID.fullmatch(value))


def build_outline(
    *, tenant_id: str, document_id: str, document_version: int,
    blocks: list[ParsedBlock],
) -> DocumentOutline:
    """Build a stable section tree from parser blocks; leaves retain canonical chunks."""
    if not _valid_uuid(tenant_id) or not _valid_uuid(document_id):
        raise InvalidOutline("tenant and document IDs must be canonical UUIDs")
    if type(document_version) is not int or document_version < 1:
        raise InvalidOutline("document_version must be a positive integer")

    roots: list[OutlineNode] = []
    stack: list[OutlineNode] = []
    chunk_ids: list[str] = []
    citations: list[ChunkCitation] = []
    heading_counts: dict[tuple[tuple[str, ...], str], int] = {}

    def node(title: str, level: int, start: int, end: int, parent_path: tuple[str, ...], occurrence: int = 1) -> OutlineNode:
        path = "/".join((*parent_path, f"{title}#{occurrence}"))
        node_id = str(uuid5(NAMESPACE_URL, f"{tenant_id}:{document_id}:{document_version}:{path}"))
        return OutlineNode(node_id, title, level, start, end)

    for block in blocks:
        if not isinstance(block, ParsedBlock) or type(block.page_start) is not int or type(block.page_end) is not int or block.page_start < 1 or block.page_end < block.page_start:
            raise InvalidOutline("block page range is invalid")
        if block.kind == "heading":
            if type(block.heading_level) is not int or not 1 <= block.heading_level <= 6:
                raise InvalidOutline("heading level must be from 1 to 6")
            title = " ".join(block.text.split())
            if not title or len(title) > 240:
                raise InvalidOutline("heading text is empty or too long")
            while stack and stack[-1].level >= block.heading_level:
                stack.pop()
            parent_path = tuple(item.node_id for item in stack)
            occurrence_key = (parent_path, title.casefold())
            heading_counts[occurrence_key] = heading_counts.get(occurrence_key, 0) + 1
            created = node(title, block.heading_level, block.page_start, block.page_end,
                           parent_path, heading_counts[occurrence_key])
            (stack[-1].children if stack else roots).append(created)
            stack.append(created)
        elif block.kind == "chunk":
            if not _valid_uuid(block.chunk_id or ""):
                raise InvalidOutline("content block requires canonical chunk_id")
            if block.chunk_id in chunk_ids:
                raise InvalidOutline("chunk_id must be unique within a document version")
            chunk_ids.append(block.chunk_id)
            citations.append(ChunkCitation(
                tenant_id, document_id, document_version, block.chunk_id,
                block.page_start, block.page_end, tuple(item.title for item in stack),
            ))
            if stack:
                stack[-1].chunk_ids.append(block.chunk_id)
                for section in stack:
                    section.page_start = min(section.page_start, block.page_start)
                    section.page_end = max(section.page_end, block.page_end)
            else:
                # Heading-less documents remain navigable under a stable synthetic root.
                if not roots or roots[-1].title != "Document content":
                    roots.append(node("Document content", 0, block.page_start, block.page_end, ()))
                roots[-1].chunk_ids.append(block.chunk_id)
                roots[-1].page_end = max(roots[-1].page_end, block.page_end)
        else:
            raise InvalidOutline("block kind must be heading or chunk")
    return DocumentOutline(tenant_id, document_id, document_version, tuple(roots),
                           tuple(chunk_ids), tuple(citations))


def resolve_chunk_citation(
    outline: DocumentOutline, *, chunk_id: str, expected_tenant_id: str,
    expected_document_id: str, expected_document_version: int,
    authorized_chunk_ids: set[str],
) -> ChunkCitation:
    """Resolve a citation only for the authorized tenant and current document version."""
    if (outline.tenant_id != expected_tenant_id
            or outline.document_id != expected_document_id
            or outline.document_version != expected_document_version):
        raise InvalidOutline("outline scope or document version is stale")
    if not _valid_uuid(chunk_id) or chunk_id not in authorized_chunk_ids:
        raise InvalidOutline("chunk is not authorized for citation")
    for citation in outline.citations:
        if citation.chunk_id == chunk_id:
            return citation
    raise InvalidOutline("chunk does not belong to this document version")


def expand_outline_selection(
    outline: DocumentOutline, *, selected_node_ids: list[str],
    authorized_chunk_ids: set[str], max_chunks: int = 8,
) -> tuple[str, ...]:
    """Expand selected sections to citation-ready chunks, fail-closed by ACL."""
    if type(max_chunks) is not int or not 1 <= max_chunks <= 50:
        raise InvalidOutline("max_chunks must be between 1 and 50")
    if (not isinstance(selected_node_ids, list) or len(selected_node_ids) > 8
            or any(not isinstance(node_id, str) or not _valid_uuid(node_id) for node_id in selected_node_ids)
            or len(set(selected_node_ids)) != len(selected_node_ids)):
        raise InvalidOutline("selected nodes must be unique and bounded")
    selected = set(selected_node_ids)
    found: list[str] = []

    def collect(current: OutlineNode) -> None:
        if len(found) >= max_chunks:
            return
        for chunk_id in current.chunk_ids:
            if chunk_id in authorized_chunk_ids and chunk_id not in found:
                found.append(chunk_id)
                if len(found) >= max_chunks:
                    return
        for child in current.children:
            collect(child)

    def walk(nodes: tuple[OutlineNode, ...] | list[OutlineNode]) -> None:
        for current in nodes:
            if current.node_id in selected:
                collect(current)
                continue
            walk(current.children)

    walk(outline.roots)
    if selected - _all_node_ids(outline.roots):
        raise InvalidOutline("selected node does not belong to this document version")
    return tuple(found[:max_chunks])


def _all_node_ids(nodes: tuple[OutlineNode, ...] | list[OutlineNode]) -> set[str]:
    result: set[str] = set()
    for current in nodes:
        result.add(current.node_id)
        result.update(_all_node_ids(current.children))
    return result
