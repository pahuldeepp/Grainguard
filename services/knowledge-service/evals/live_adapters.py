"""Opt-in real retrieval ports; synthetic workload, Gateway accounting tenant.

Pinecone cleanup tracks attempted writes, including ambiguous provider failures.
The evaluation's disposable tenant is independent from the configured billing tenant.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from knowledge_extensions.model_gateway import ModelGatewayClient, verified_gateway_user
from knowledge_extensions.vector_store import PineconeVectorStore


class LivePorts:
    def __init__(self):
        secrets = Path(os.environ.get('GREENGUARD_SECRETS_DIR', str(Path.home()/'.config/greenguard/secrets')))
        self.tenant = os.environ.get('RAG_EVAL_GATEWAY_TENANT', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        self.gateway = ModelGatewayClient(
            base_url=os.environ.get('RAG_EVAL_GATEWAY_URL', 'http://127.0.0.1:18089'),
            task_token=(secrets/'gateway-caller-token').read_text().strip(), timeout_seconds=40)
        index = json.loads((secrets/'pinecone-index.json').read_text())
        self.store = PineconeVectorStore(index_host=index['host'], api_key=(secrets/'pinecone-api-key').read_text().strip())
        self.writes = {}
        self.embedding_cache = {}
        self.ranking_cache = {}
        self.last_call = 0.0
        self.spacing = float(os.environ.get('RAG_EVAL_PROVIDER_SPACING_SECONDS', '21'))
        if not 0 <= self.spacing <= 60:
            raise ValueError('provider spacing must be within 0..60 seconds')

    def pace(self):
        delay = self.spacing - (time.monotonic() - self.last_call)
        if delay > 0:
            time.sleep(delay)
        self.last_call = time.monotonic()

    def embed(self, texts, *, model, input_type, **kwargs):
        missing = list(dict.fromkeys(text for text in texts if (model,input_type,text) not in self.embedding_cache))
        if missing:
            self.pace()
            with verified_gateway_user('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' if input_type == 'query' else None):
                values = self.gateway.embed(missing, tenant_id=self.tenant, model=model, input_type=input_type)
            for text, vector in zip(missing, values, strict=True):
                self.embedding_cache[(model,input_type,text)] = vector
        return [self.embedding_cache[(model,input_type,text)] for text in texts]

    def rerank(self, query, documents, *, model, top_n, **kwargs):
        key = (query,tuple(documents),model,top_n)
        if key not in self.ranking_cache:
            self.pace()
            with verified_gateway_user('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'):
                self.ranking_cache[key] = self.gateway.rerank(query, documents, tenant_id=self.tenant, model=model, top_n=top_n)
        return list(self.ranking_cache[key])

    def answer(self, question, context, *, model, **kwargs):
        self.pace()
        with verified_gateway_user('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'):
            return self.gateway.answer(question, context, tenant_id=self.tenant, model=model)

    def upsert(self, *, namespace, records):
        self.writes.setdefault(namespace, set()).update(r.chunk_id for r in records)
        self.store.upsert(namespace=namespace, records=records)

    def search(self, **kwargs):
        return self.store.search(**kwargs)

    def delete(self, *, namespace, chunk_ids):
        self.store.delete(namespace=namespace, chunk_ids=chunk_ids)

    def await_index(self):
        # Pinecone is eventually consistent. Poll namespace counts, not one hit.
        if not self.writes:
            return
        for attempt in range(30):
            counts = self.store.describe_stats().get('namespaces', {})
            if all(counts.get(namespace, {}).get('vectorCount', 0) >= len(ids)
                   for namespace, ids in self.writes.items()):
                return
            time.sleep(1)
        raise RuntimeError('Pinecone eval indexing visibility timed out')

    def close(self):
        failures = []
        for namespace, ids in list(self.writes.items()):
            try:
                self.store.delete(namespace=namespace, chunk_ids=sorted(ids))
            except Exception:
                failures.append(namespace)
            else:
                del self.writes[namespace]
        if failures:
            raise RuntimeError('Eval vector cleanup failed; retry namespaces: '+','.join(failures))
