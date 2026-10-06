"""Deterministic local-only adapters for the disposable RAG acceptance path."""

from __future__ import annotations

import hashlib
import math
import re

from knowledge_extensions.vector_store import VectorHit, VectorRecord


class LocalEmbedding:
    model = "local-hash-embedding-v1"

    def embed(self, texts: list[str], *, tenant_id: str, model: str, input_type: str) -> list[list[float]]:
        if model != self.model:
            raise ValueError("unexpected local embedding model")
        vectors = []
        for text in texts:
            vector = [0.0] * 128
            for token in re.findall(r"[\w]+", text.casefold()):
                digest = hashlib.sha256(token.encode()).digest()
                index = int.from_bytes(digest[:4], "big") % len(vector)
                vector[index] += 1.0 if digest[4] & 1 else -1.0
            norm = math.sqrt(sum(value * value for value in vector)) or 1.0
            vectors.append([value / norm for value in vector])
        return vectors


class LocalVectorStore:
    def __init__(self) -> None:
        self.records: dict[str, dict[str, VectorRecord]] = {}

    def upsert(self, *, namespace: str, records: list[VectorRecord]) -> None:
        target = self.records.setdefault(namespace, {})
        for record in records:
            target[record.chunk_id] = record

    def search(self, *, namespace: str, vector: list[float], top_k: int, document_scope=None) -> list[VectorHit]:
        matches = []
        for chunk_id, record in self.records.get(namespace, {}).items():
            if document_scope and (record.metadata.get("doc_id"), record.metadata.get("doc_version")) != document_scope:
                continue
            score = sum(a * b for a, b in zip(vector, record.values, strict=True))
            matches.append(VectorHit(chunk_id, score, record.metadata))
        return [VectorHit(item.chunk_id, item.score, item.metadata)
                for item in sorted(matches, key=lambda value: (-value.score, value.chunk_id))[:top_k]]

    def delete(self, *, namespace: str, chunk_ids: list[str]) -> None:
        records = self.records.get(namespace, {})
        for chunk_id in chunk_ids:
            records.pop(chunk_id, None)


class LocalReranker:
    model = "local-overlap-reranker-v1"

    def rerank(self, query: str, documents: list[str], *, tenant_id: str, model: str, top_n: int) -> list[int]:
        if model != self.model:
            raise ValueError("unexpected local reranker model")
        query_terms = set(re.findall(r"[\w]+", query.casefold()))
        scores = [len(query_terms & set(re.findall(r"[\w]+", text.casefold())))
                  for text in documents]
        return sorted(range(len(documents)), key=lambda index: (-scores[index], index))[:top_n]


class LocalAnswerGenerator:
    model = "local-citation-answer-stub-v1"

    def answer(self, question: str, context: list[dict[str, str]], *, tenant_id: str, model: str):
        if model != self.model or not context:
            raise ValueError("unexpected local answer model or empty context")
        return {
            "answer": f"The retrieved document discusses: {context[0]['text'][:180]}",
            "cited_chunk_ids": [context[0]["chunk_id"]],
        }
