"""Bounded Redis caches: hashed keys, vectors and candidate IDs, never source prose."""
from __future__ import annotations
import hashlib
import json
import math
import socket
import ssl
import time
import threading
import ipaddress
from collections import OrderedDict
from urllib.parse import urlsplit, unquote
from uuid import UUID


class RedisJsonCache:
    """Small RESP2 GET/SETEX adapter. Cache outages fall back to fresh retrieval."""
    def __init__(self, url: str, *, ttl_seconds: int = 120, embedding_ttl_seconds: int = 900, failure_cooldown_seconds: float = 5, ca_file: str | None = None):
        self.url = urlsplit(url)
        if (self.url.scheme not in {'redis', 'rediss'} or not self.url.hostname
                or self.url.query or self.url.fragment):
            raise ValueError('invalid Redis URL')
        try:
            private = ipaddress.ip_address(self.url.hostname).is_private
        except ValueError:
            private = self.url.hostname == 'localhost' or self.url.hostname.endswith(('.internal', '.svc', '.svc.cluster.local'))
        if not private:
            raise ValueError('Redis must use a private configured origin')
        database = self.url.path.lstrip('/') or '0'
        if not database.isdigit() or not 0 <= int(database) <= 15:
            raise ValueError('invalid Redis database')
        self.tls_context = ssl.create_default_context(cafile=ca_file) if self.url.scheme == "rediss" else None
        if ca_file and self.tls_context is None:
            raise ValueError("Redis CA requires verified TLS")
        self.database = database
        if not 1 <= ttl_seconds <= 300 or not 1 <= embedding_ttl_seconds <= 3600:
            raise ValueError('invalid cache TTL')
        self.ttl_seconds = ttl_seconds
        self.embedding_ttl_seconds = embedding_ttl_seconds
        if (type(failure_cooldown_seconds) not in {int, float}
                or not math.isfinite(failure_cooldown_seconds)
                or not 1 <= failure_cooldown_seconds <= 30):
            raise ValueError('invalid cache failure cooldown')
        self.failure_cooldown_seconds = failure_cooldown_seconds
        self._failure_lock = threading.Lock()
        self._retry_after = 0.0
        self._command_active = False
        self._metrics = OrderedDict()
        self._metrics_lock = threading.Lock()

    def record_lookup(self, tenant_id, kind, hit):
        if kind not in {'retrieval', 'embedding'}:
            raise ValueError('invalid cache metric kind')
        with self._metrics_lock:
            counts = self._metrics.setdefault(tenant_id, {'retrieval_hits': 0, 'retrieval_misses': 0, 'embedding_hits': 0, 'embedding_misses': 0})
            counts[kind + ('_hits' if hit else '_misses')] += 1
            self._metrics.move_to_end(tenant_id)
            while len(self._metrics) > 1000:
                self._metrics.popitem(last=False)

    def snapshot(self, tenant_id):
        with self._metrics_lock:
            counts = dict(self._metrics.get(tenant_id, {'retrieval_hits': 0, 'retrieval_misses': 0, 'embedding_hits': 0, 'embedding_misses': 0}))
        total = sum(counts.values())
        return {'available': True, 'redis': 'configured', **counts,
                'hit_ratio': (counts['retrieval_hits'] + counts['embedding_hits']) / total if total else None,
                'retrieval_ttl_seconds': self.ttl_seconds, 'embedding_ttl_seconds': self.embedding_ttl_seconds,
                'window': 'Since this service process started; bounded to 1000 recent tenants',
                'source': 'Tenant-scoped cache lookups; misses include invalid values and cache outages',
                'health': 'Not measured by lookup counters'}

    @staticmethod
    def key(kind: str, identity: list) -> str:
        return 'gg:knowledge:v1:' + kind + ':' + hashlib.sha256(json.dumps(identity, separators=(',', ':'), sort_keys=True).encode()).hexdigest()

    def _command(self, *parts):
        deadline = time.monotonic() + 1
        connection = socket.create_connection((self.url.hostname, self.url.port or 6379), timeout=1)
        if self.url.scheme == 'rediss':
            connection = self.tls_context.wrap_socket(connection, server_hostname=self.url.hostname)
        with connection:
            def read(size):
                result = bytearray()
                while len(result) < size:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0: raise TimeoutError('cache deadline exceeded')
                    connection.settimeout(remaining)
                    part = connection.recv(size - len(result))
                    if not part: raise ValueError('cache connection closed')
                    result.extend(part)
                return bytes(result)
            def readline():
                line = bytearray()
                while len(line) < 4096:
                    line.extend(read(1))
                    if line.endswith(b'\r\n'): return bytes(line)
                raise ValueError('cache response line too large')
            def command(parts):
                encoded = [str(p).encode() for p in parts]
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise TimeoutError('cache deadline exceeded')
                connection.settimeout(remaining)
                connection.sendall(b'*' + str(len(encoded)).encode() + b'\r\n' + b''.join(b'$'+str(len(p)).encode()+b'\r\n'+p+b'\r\n' for p in encoded))
                line = readline()
                if line.startswith(b'$'):
                    size = int(line[1:])
                    if size == -1: return None
                    if not 0 <= size <= 262144: raise ValueError('cache value too large')
                    value = read(size)
                    if len(value) != size or read(2) != b'\r\n': raise ValueError('invalid cache response')
                    return value
                if line.startswith(b'+'): return line[1:-2]
                raise ValueError('cache command failed')
            if self.url.password:
                command(['AUTH', unquote(self.url.username or 'default'), unquote(self.url.password)])
            if self.database != '0': command(['SELECT', self.database])
            return command(parts)

    def _available_command(self, *parts):
        # Healthy commands run concurrently. Only recovery after a recorded
        # failure uses a single probe; other callers fall back to retrieval.
        with self._failure_lock:
            if time.monotonic() < self._retry_after:
                return None
            probe = self._retry_after > 0
            if probe and self._command_active:
                return None
            if probe:
                self._command_active = True
        failed = False
        try:
            return self._command(*parts)
        except (OSError, ValueError, TypeError):
            failed = True
            raise
        finally:
            with self._failure_lock:
                if failed:
                    self._retry_after = time.monotonic() + self.failure_cooldown_seconds
                elif probe:
                    self._retry_after = 0.0
                if probe:
                    self._command_active = False

    def get(self, key: str):
        try:
            value = self._available_command('GET', key)
            return json.loads(value) if value is not None else None
        except (OSError, ValueError, TypeError):
            return None

    def put(self, key: str, value, *, embedding: bool = False):
        try:
            payload = json.dumps(value, separators=(',', ':'), allow_nan=False)
            if len(payload.encode()) > 262144: return
            self._available_command('SETEX', key, self.embedding_ttl_seconds if embedding else self.ttl_seconds, payload)
        except (OSError, ValueError, TypeError):
            pass


def valid_vector(value):
    return (isinstance(value, list) and 1 <= len(value) <= 8192
            and all(type(v) in {int, float} and math.isfinite(v) for v in value))


def valid_rankings(value, limit):
    if not isinstance(value, dict) or set(value) != {'dense', 'fts', 'pageindex', 'knowledge_graph'}:
        return False
    try:
        return all(isinstance(ids, list) and len(ids) <= limit and all(isinstance(i,str) and str(UUID(i)) == i for i in ids) for ids in value.values())
    except (ValueError, TypeError):
        return False


def corpus_revision(connection, tenant, scope):
    """Read the transactional tenant revision in O(1); scope remains in cache key.

    Missing/invalid revisions disable candidate reuse; hydration stays mandatory.
    Call inside a tenant-bound transaction. Migration must precede runtime rollout.
    """
    row = connection.execute(
        'SELECT revision FROM knowledge_cache_revisions WHERE tenant_id=%s',
        (tenant,),
    ).fetchone()
    return row[0] if row and type(row[0]) is int and row[0] > 0 else None


class CachedModelPorts:
    """Cache already-redacted query/passage embeddings; batch all misses once.

    Authorization stays in service/retrieval. Rerank and answer always delegate.
    Provider retries and billing controls remain in the model gateway.
    """
    def __init__(self, delegate, cache: RedisJsonCache, namespace_key: bytes):
        self.delegate = delegate
        self.cache = cache
        self.namespace_key = namespace_key

    def embed(self, texts, *, tenant_id, model, input_type):
        from .retrieval import tenant_namespace, RetrievalError
        from .redaction import redact_passages
        namespace = tenant_namespace(tenant_id, self.namespace_key)
        safe_texts = redact_passages(texts)
        keys = [self.cache.key('embedding', [namespace, model, input_type, text]) for text in safe_texts]
        result = [self.cache.get(key) for key in keys]
        for value in result:
            if hasattr(self.cache, 'record_lookup'):
                self.cache.record_lookup(tenant_id, 'embedding', valid_vector(value))
        missing = [i for i, value in enumerate(result) if not valid_vector(value)]
        if missing:
            vectors = self.delegate.embed([safe_texts[i] for i in missing],tenant_id=tenant_id,model=model,input_type=input_type)
            if (len(vectors) != len(missing) or any(not valid_vector(v) for v in vectors)
                    or len({len(v) for v in vectors}) != 1):
                raise RetrievalError('embedding provider returned invalid cache batch')
            for index, vector in zip(missing, vectors, strict=True):
                result[index] = vector
                self.cache.put(keys[index], vector, embedding=True)
        if result and len({len(v) for v in result}) != 1:
            # Reject incompatible dimensions instead of caching or sending them.
            raise RetrievalError('cached embedding dimensions differ')
        return result

    def rerank(self, *args, **kwargs):
        return self.delegate.rerank(*args, **kwargs)

    def answer(self, *args, **kwargs):
        return self.delegate.answer(*args, **kwargs)
