"""Vector-store ports plus the Pinecone dense-vector REST adapter."""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
import re
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request
from .http_transport import urlopen


class VectorStoreError(RuntimeError):
    """Vector provider failed or returned an invalid response."""


@dataclass(frozen=True, slots=True)
class VectorRecord:
    chunk_id: str
    values: tuple[float, ...]
    metadata: dict[str, str | int | bool]


@dataclass(frozen=True, slots=True)
class VectorHit:
    chunk_id: str
    score: float
    metadata: dict[str, Any]


class VectorStore(Protocol):
    def upsert(self, *, namespace: str, records: list[VectorRecord]) -> None: ...
    def search(self, *, namespace: str, vector: list[float], top_k: int, document_scope: tuple[str, int] | None = None) -> list[VectorHit]: ...
    def delete(self, *, namespace: str, chunk_ids: list[str]) -> None: ...


class PineconeVectorStore:
    """Minimal-metadata Pinecone adapter using the versioned data-plane API."""

    API_VERSION = "2025-04"
    MAX_UPSERT_BYTES = 1_900_000

    def __init__(self, *, index_host: str, api_key: str, timeout_seconds: float = 8.0):
        parsed = urlsplit(index_host if "://" in index_host else f"https://{index_host}")
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                or parsed.password or parsed.path not in {"", "/"}):
            raise ValueError("Pinecone index host must be a bare HTTPS host")
        if not api_key or len(api_key) > 512 or not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("Pinecone credentials or timeout are invalid")
        self._base_url = f"https://{parsed.netloc}"
        self._api_key = api_key
        self._timeout = timeout_seconds

    def describe_stats(self) -> dict[str, Any]:
        return self._request('/describe_index_stats', {})

    def _request(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        request = Request(
            f"{self._base_url}{path}", data=json.dumps(body, separators=(",", ":")).encode(),
            headers={"Api-Key": self._api_key, "Content-Type": "application/json",
                     "X-Pinecone-Api-Version": self.API_VERSION}, method="POST",
        )
        try:
            with urlopen(request, timeout=self._timeout) as response:
                result = json.loads(response.read(2_000_001))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            # Do not surface response bodies or credentials in exceptions/logs.
            raise VectorStoreError("Pinecone request failed") from exc
        if not isinstance(result, dict):
            raise VectorStoreError("Pinecone returned an invalid response")
        return result

    def upsert(self, *, namespace: str, records: list[VectorRecord]) -> None:
        if not namespace or not records or len(records) > 256:
            raise ValueError("Pinecone upsert requires a namespace and 1-256 records")
        vectors = []
        dimension: int | None = None
        for record in records:
            if (not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", record.chunk_id)
                    or not record.values or any(not math.isfinite(value) for value in record.values)):
                raise ValueError("vector record is invalid")
            allowed_metadata = {"doc_id", "doc_version", "tenant_ref", "trust",
                                "acl_scope", "embedding_version", "tombstone"}
            if set(record.metadata) != allowed_metadata or "text" in record.metadata:
                raise ValueError("Pinecone metadata must match the minimal allowlist")
            dimension = dimension or len(record.values)
            if len(record.values) != dimension:
                raise ValueError("vector dimensions do not match")
            vectors.append({"id": record.chunk_id, "values": list(record.values),
                            "metadata": record.metadata})
        def submit(batch):
            result=self._request("/vectors/upsert", {"namespace":namespace,"vectors":batch})
            count=result.get("upsertedCount")
            if type(count) is not int or count!=len(batch):
                raise VectorStoreError("Pinecone did not acknowledge the complete vector batch")
        batch: list[dict[str, Any]] = []
        base_size=len(json.dumps({"namespace":namespace,"vectors":[]},separators=(",", ":")).encode())
        size=base_size
        for vector in vectors:
            vector_size=len(json.dumps(vector,separators=(",", ":")).encode())
            if base_size+vector_size>self.MAX_UPSERT_BYTES:
                raise ValueError("one vector exceeds Pinecone upsert payload limit")
            added=vector_size+(1 if batch else 0)
            if size+added>self.MAX_UPSERT_BYTES:
                submit(batch)
                batch=[]
                size=base_size
                added=vector_size
            batch.append(vector)
            size+=added
        if batch:
            submit(batch)

    def delete(self, *, namespace: str, chunk_ids: list[str]) -> None:
        if not namespace or not chunk_ids or len(chunk_ids) > 1000:
            raise ValueError("Pinecone delete requires 1-1000 chunk IDs")
        self._request("/vectors/delete", {"namespace": namespace, "ids": chunk_ids})

    def search(self, *, namespace: str, vector: list[float], top_k: int, document_scope: tuple[str, int] | None = None) -> list[VectorHit]:
        if not namespace or not vector or any(not math.isfinite(value) for value in vector):
            raise ValueError("vector query is invalid")
        if type(top_k) is not int or not 1 <= top_k <= 100:
            raise ValueError("top_k must be between 1 and 100")
        metadata_filter = {"tombstone": {"$eq": False}}
        if document_scope:
            metadata_filter.update(doc_id={"$eq": document_scope[0]}, doc_version={"$eq": document_scope[1]})
        payload = self._request("/query", {
            "namespace": namespace, "vector": vector, "topK": top_k,
            "includeMetadata": True,
            "filter": metadata_filter,
        })
        matches = payload.get("matches", [])
        if not isinstance(matches, list):
            raise VectorStoreError("Pinecone returned invalid matches")
        hits: list[VectorHit] = []
        for match in matches[:top_k]:
            if not isinstance(match, dict) or not isinstance(match.get("id"), str):
                continue
            try:
                score = float(match.get("score"))
            except (TypeError, ValueError):
                continue
            metadata = match.get("metadata") or {}
            if math.isfinite(score) and isinstance(metadata, dict):
                hits.append(VectorHit(match["id"], score, metadata))
        return hits
