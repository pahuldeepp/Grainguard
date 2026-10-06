"""Optional, read-only ClickHouse summary for synthetic ML operations."""
from __future__ import annotations

import base64
import json
import ipaddress
import os
import socket
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen


def _query(endpoint: str, sql: str, tenant_id: str, timeout: float,
           username: str, password: str) -> list[dict]:
    parsed = urlsplit(endpoint)
    params = urlencode({"param_tenant_id": tenant_id, "default_format": "JSONEachRow"})
    url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", params, ""))
    headers = {"Content-Type": "text/plain; charset=utf-8", "Accept": "application/x-ndjson"}
    if username or password:
        token = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
        headers["Authorization"] = f"Basic {token}"
    request = Request(url, data=sql.encode("utf-8"), headers=headers, method="POST")
    with urlopen(request, timeout=timeout) as response:
        return [json.loads(line) for line in response.read().decode("utf-8").splitlines() if line]


def clickhouse_summary(tenant_id: str) -> dict:
    """Read bounded aggregate summaries; ClickHouse failures never break ML ops."""
    endpoint = os.environ.get("ML_CLICKHOUSE_URL", "").strip()
    if not endpoint:
        return {"status": "unavailable", "reason": "not_configured", "rows": 0,
                "bins": 0, "averageTemperatureC": None, "averageHumidityPercent": None}
    parsed = urlsplit(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return {"status": "unavailable", "reason": "invalid_endpoint", "rows": 0,
                "bins": 0, "averageTemperatureC": None, "averageHumidityPercent": None}
    if parsed.scheme == "http":
        try:
            resolved = {ipaddress.ip_address(answer[4][0]).is_loopback
                        for answer in socket.getaddrinfo(parsed.hostname, parsed.port or 80)}
        except (OSError, ValueError):
            resolved = set()
        if not resolved or not all(resolved):
            return {"status": "unavailable", "reason": "https_required", "rows": 0,
                    "bins": 0, "averageTemperatureC": None, "averageHumidityPercent": None}
    username = os.environ.get("ML_CLICKHOUSE_USER", "")
    password = os.environ.get("ML_CLICKHOUSE_PASSWORD", "")
    timeout = min(max(float(os.environ.get("ML_CLICKHOUSE_TIMEOUT_SECONDS", "1.5")), .1), 3.0)
    aggregate_sql = """SELECT count() AS rows, uniqExact(bin_id) AS bins,
        avg(temperature_c) AS averageTemperatureC,
        avg(relative_humidity_percent) AS averageHumidityPercent
        FROM greenguard_analytics.telemetry_events FINAL
        WHERE tenant_id = {tenant_id:UUID} AND observed_at >= now() - INTERVAL 24 HOUR"""
    try:
        aggregates = _query(endpoint, aggregate_sql, tenant_id, timeout, username, password)
        result = aggregates[0] if aggregates else {}
        return {"status": "ready", "reason": None, "rows": int(result.get("rows", 0)),
                "bins": int(result.get("bins", 0)),
                "averageTemperatureC": float(result["averageTemperatureC"]) if result.get("averageTemperatureC") is not None else None,
                "averageHumidityPercent": float(result["averageHumidityPercent"]) if result.get("averageHumidityPercent") is not None else None}
    except Exception:
        return {"status": "unavailable", "reason": "query_failed", "rows": 0,
                "bins": 0, "averageTemperatureC": None, "averageHumidityPercent": None}
