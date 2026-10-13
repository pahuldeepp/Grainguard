"""Private four-shard registry; only the authenticated authority selects a tenant owner.

No expired route, failed lookup, or unknown shard falls back to another database.
Each PgDatabase retains at most one connection. Every customer transaction holds
the SQL ownership admission lock until commit, including policy API operations.
"""
from __future__ import annotations

import json
import re
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterator
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from risk_engine.store import PgDatabase, PgTx, StoreError

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHARDS = frozenset({"s1", "s2", "s3", "s4"})
FIELDS = frozenset({"tenantId", "shardId", "shardIncarnation", "placementEpoch", "state", "expiresAt"})


def validate_route(value: Any, tenant: str, now: float) -> dict[str, str]:
    if (not UUID.fullmatch(tenant) or not isinstance(value, dict) or set(value) != FIELDS
            or not all(isinstance(v, str) for v in value.values())
            or value["tenantId"] != tenant or value["shardId"] not in SHARDS
            or not UUID.fullmatch(value["shardIncarnation"])
            or not re.fullmatch(r"[1-9]\d{0,18}", value["placementEpoch"], re.ASCII)
            or int(value["placementEpoch"]) > 9223372036854775807):
        raise StoreError("42501", "invalid placement authority response")
    try:
        expires = datetime.fromisoformat(value["expiresAt"].replace("Z", "+00:00"))
        if expires.tzinfo is None or not 0 < expires.timestamp() - now <= 2:
            raise ValueError("expired")
    except ValueError as exc:
        raise StoreError(None, "placement lease expired") from exc
    if value["state"] != "active":
        raise StoreError("55P03", "tenant placement is not active")
    return dict(value)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def authority_fetcher(base_url: str, token: str, mesh_mtls: bool = False):
    endpoint = urlsplit(base_url)
    if (endpoint.scheme not in {"https", "http"} or not endpoint.hostname
            or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
            or not token or "\n" in token or "\r" in token
            or (endpoint.scheme == "http" and endpoint.hostname not in {"localhost", "127.0.0.1", "::1"}
                and not mesh_mtls)):
        raise ValueError("invalid placement authority configuration")
    opener = build_opener(_NoRedirect())

    def fetch(tenant: str):
        if not UUID.fullmatch(tenant):
            raise StoreError("42501", "invalid tenant identifier")
        request = Request(base_url.rstrip("/") + "/v1/internal/placements/" + tenant,
                          headers={"Authorization": "Bearer " + token})
        try:
            with opener.open(request, timeout=2) as response:
                body = response.read(4097)
                if response.status != 200 or len(body) > 4096:
                    raise ValueError("invalid response")
                return json.loads(body)
        except Exception:
            # Never expose URLs, credentials, or upstream bodies to logs/HTTP.
            raise StoreError(None, "placement authority unavailable") from None
    return fetch


def _validate_registry(manifest: Any) -> None:
    if (not isinstance(manifest, dict)
            or set(manifest) != {"formatVersion", "service", "database", "shards"}
            or type(manifest["formatVersion"]) is not int or manifest["formatVersion"] != 1
            or manifest["service"] != "risk-engine" or manifest["database"] != "greenguard_risk"
            or not isinstance(manifest["shards"], dict) or set(manifest["shards"]) != SHARDS):
        raise ValueError("invalid risk shard registry")


def _primary_endpoint(entry: Any, allow_loopback: bool):
    if (not isinstance(entry, dict) or set(entry) != {"incarnation", "primaryUrl", "replicaUrls"}
            or not isinstance(entry["incarnation"], str) or not UUID.fullmatch(entry["incarnation"])
            or not isinstance(entry["primaryUrl"], str) or not isinstance(entry["replicaUrls"], list)):
        raise ValueError("invalid risk shard registry")
    url = urlsplit(entry["primaryUrl"])
    query = parse_qs(url.query, keep_blank_values=True)
    local = allow_loopback and url.hostname in {"localhost", "127.0.0.1", "::1"}
    if (url.scheme not in {"postgres", "postgresql"} or url.username != "risk_app"
            or url.path != "/greenguard_risk" or not url.hostname or not url.password or url.fragment
            or (not local and (query.get("sslmode") != ["verify-full"]
                               or len(query.get("sslrootcert", [])) != 1
                               or not query["sslrootcert"][0]))
            or set(query) - {"sslmode", "sslrootcert", "sslcert", "sslkey", "connect_timeout"}
            or any(len(values) != 1 for values in query.values())):
        raise ValueError("unsafe risk primary configuration")
    return (url.hostname, url.port or 5432, url.path), local


def _active_shards(active_ids, allow_loopback: bool, loopback_endpoints: bool):
    if active_ids is None:
        active_ids = sorted(SHARDS)
    else:
        if not isinstance(active_ids, list) or any(not isinstance(shard, str) for shard in active_ids):
            raise ValueError("active shard override must be a list of shard IDs")
        active_ids = [shard.strip() for shard in active_ids]
        if (not allow_loopback or not loopback_endpoints or not active_ids
                or "s1" not in active_ids
                or len(active_ids) != len(set(active_ids))
                or any(shard not in SHARDS for shard in active_ids)):
            raise ValueError("active shard override is allowed only for unique local loopback shards")
    return active_ids


class ShardedDatabase:
    def __init__(self, manifest: Any, fetch: Callable[[str], Any], *, allow_loopback=False,
                 active_ids: list[str] | None = None,
                 database: Callable[[str], Any] = PgDatabase, clock=time.time, observe=None):
        _validate_registry(manifest)
        identities, urls, endpoints = {}, {}, set()
        loopback_endpoints = True
        for shard, entry in manifest["shards"].items():
            address, local = _primary_endpoint(entry, allow_loopback)
            loopback_endpoints = loopback_endpoints and local
            if address in endpoints:
                raise ValueError("duplicate risk primary")
            endpoints.add(address)
            identities[shard], urls[shard] = entry["incarnation"], entry["primaryUrl"]
        active_ids = _active_shards(active_ids, allow_loopback, loopback_endpoints)
        # Validate the entire manifest before constructing even one database.
        self.identities, self.fetch, self.clock, self.observe = identities, fetch, clock, observe
        self.active_ids = tuple(active_ids)
        self.databases = {shard: database(urls[shard]) for shard in sorted(SHARDS)}

    @classmethod
    def from_env(cls, getenv, observe=None):
        raw_active = getenv("SHARD_ACTIVE_IDS")
        return cls(json.loads(Path(getenv("SHARD_REGISTRY_FILE")).read_text()),
                   authority_fetcher(getenv("CONTROL_PLANE_URL") or "", getenv("CONTROL_LOOKUP_TOKEN") or "",
                                     getenv("CONTROL_PLANE_MESH_MTLS") == "true"),
                   allow_loopback=getenv("SHARD_LOCAL_LOOPBACK") == "true",
                   active_ids=[shard.strip() for shard in raw_active.split(",")] if raw_active else None,
                   observe=observe)

    @contextmanager
    def transaction(self, tenant_id: str) -> Iterator[PgTx]:
        started, failed = time.monotonic(), True
        try:
            value = self.fetch(tenant_id)
            route = validate_route(value, tenant_id, self.clock())
            if route["shardId"] not in self.active_ids:
                raise StoreError("42501", "placement references an inactive shard")
            if self.identities[route["shardId"]] != route["shardIncarnation"]:
                raise StoreError("42501", "placement incarnation mismatch")
            failed = False
        except StoreError:
            raise
        except Exception:
            raise StoreError(None, "placement authority unavailable") from None
        finally:
            if self.observe:
                self.observe(time.monotonic() - started, failed)
        with self.databases[route["shardId"]].transaction(tenant_id, route) as tx:
            yield tx

    def quarantine(self, *args):
        # Explicit transport diagnostics ledger: no tenant, payload, or domain rows.
        # Kept on s1 independently of customer placement; never a routing fallback.
        return self.databases["s1"].quarantine(*args)

    def ping(self):
        return all(self.databases[shard].ping() for shard in self.active_ids)

    def close(self):
        for db in self.databases.values():
            db.close()
