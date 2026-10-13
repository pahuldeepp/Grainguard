"""Small provenance-first graph projection helpers for I7 experiments.

The module is deterministic and storage-neutral. Candidate facts are inert until
reviewed, and traversal requires an explicit tenant and authorized chunk set.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re
import unicodedata
from uuid import NAMESPACE_URL, uuid5


ENTITY_TYPES = frozenset({"grain", "hazard", "symptom", "condition", "measurement", "practice"})
PREDICATES = frozenset({"has_hazard", "indicated_by", "occurs_under", "measured_by", "mitigated_by"})
TRUST_LEVELS = frozenset({"curated", "licensed", "tenant_uploaded"})
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")


class InvalidGraphFact(ValueError):
    """A graph fact lacks valid type, scope, or source provenance."""


def _uuid(value: str, field: str) -> str:
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        raise InvalidGraphFact(f"{field} must be a canonical UUID")
    return value


def _label(value: str, field: str, maximum: int = 160) -> str:
    if not isinstance(value, str):
        raise InvalidGraphFact(f"{field} must be text")
    normalized = " ".join(unicodedata.normalize("NFKC", value).split())
    if not normalized or len(normalized) > maximum or any(ord(ch) < 32 for ch in normalized):
        raise InvalidGraphFact(f"{field} is empty or outside its size limit")
    return normalized


@dataclass(frozen=True, slots=True)
class GraphEntity:
    entity_id: str
    tenant_id: str
    entity_type: str
    label: str


@dataclass(frozen=True, slots=True)
class GraphFact:
    edge_id: str
    tenant_id: str
    source_entity_id: str
    predicate: str
    target_entity_id: str
    document_id: str
    document_version: int
    chunk_id: str
    span_start: int
    span_end: int
    trust: str
    status: str = "candidate"


def make_entity(tenant_id: str, entity_type: str, label: str) -> GraphEntity:
    tenant_id = _uuid(tenant_id, "tenant_id")
    if entity_type not in ENTITY_TYPES:
        raise InvalidGraphFact("unsupported entity type")
    label = _label(label, "label")
    identity = f"{tenant_id}:{entity_type}:{label.casefold()}"
    return GraphEntity(str(uuid5(NAMESPACE_URL, identity)), tenant_id, entity_type, label)


def make_candidate_fact(
    *, tenant_id: str, source: GraphEntity, predicate: str, target: GraphEntity,
    document_id: str, document_version: int, chunk_id: str,
    span_start: int, span_end: int, trust: str,
) -> GraphFact:
    tenant_id = _uuid(tenant_id, "tenant_id")
    if (not isinstance(source, GraphEntity) or not isinstance(target, GraphEntity)
            or not _UUID.fullmatch(source.entity_id) or not _UUID.fullmatch(target.entity_id)
            or source.entity_type not in ENTITY_TYPES or target.entity_type not in ENTITY_TYPES):
        raise InvalidGraphFact("source and target must be valid graph entities")
    if source.tenant_id != tenant_id or target.tenant_id != tenant_id:
        raise InvalidGraphFact("entity tenant does not match fact tenant")
    if predicate not in PREDICATES:
        raise InvalidGraphFact("unsupported graph predicate")
    _uuid(document_id, "document_id")
    _uuid(chunk_id, "chunk_id")
    if type(document_version) is not int or document_version < 1:
        raise InvalidGraphFact("document_version must be a positive integer")
    if type(span_start) is not int or type(span_end) is not int or span_start < 0 or span_end <= span_start:
        raise InvalidGraphFact("source span is invalid")
    if trust not in TRUST_LEVELS:
        raise InvalidGraphFact("unsupported source trust")
    material = ":".join((tenant_id, source.entity_id, predicate, target.entity_id,
                         document_id, str(document_version), chunk_id,
                         str(span_start), str(span_end)))
    edge_id = hashlib.sha256(material.encode()).hexdigest()
    return GraphFact(edge_id, tenant_id, source.entity_id, predicate, target.entity_id,
                     document_id, document_version, chunk_id, span_start, span_end, trust)


def traverse_reviewed(
    facts: list[GraphFact], *, tenant_id: str, start_entity_id: str,
    authorized_chunk_ids: set[str], current_versions: dict[str, int],
    max_depth: int = 2, max_facts: int = 20,
) -> tuple[GraphFact, ...]:
    """Return only reviewed, current, source-authorized edges for this tenant."""
    tenant_id = _uuid(tenant_id, "tenant_id")
    _uuid(start_entity_id, "start_entity_id")
    if type(max_depth) is not int or not 1 <= max_depth <= 2:
        raise InvalidGraphFact("max_depth must be between 1 and 2")
    if type(max_facts) is not int or not 1 <= max_facts <= 100:
        raise InvalidGraphFact("max_facts must be between 1 and 100")
    frontier = {start_entity_id}
    selected: list[GraphFact] = []
    seen: set[str] = set()
    for _ in range(max_depth):
        next_frontier: set[str] = set()
        for fact in facts:
            if (fact.edge_id in seen or fact.status != "reviewed" or fact.tenant_id != tenant_id
                    or fact.chunk_id not in authorized_chunk_ids
                    or current_versions.get(fact.document_id) != fact.document_version
                    or fact.source_entity_id not in frontier):
                continue
            selected.append(fact)
            seen.add(fact.edge_id)
            next_frontier.add(fact.target_entity_id)
            if len(selected) >= max_facts:
                return tuple(selected)
        frontier = next_frontier
        if not frontier:
            break
    return tuple(selected)
