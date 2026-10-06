"""Standard-library-only subprocess for bounded owner API HTTP calls."""
from __future__ import annotations

import base64
import json
import sys
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from urllib.error import HTTPError


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _reject_json_constant(value):
    raise ValueError("invalid_json_constant:" + value)


def main() -> None:
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise SystemExit(2)
    request = json.loads(raw, parse_constant=_reject_json_constant)
    body = base64.b64decode(request["body"], validate=True)
    headers = dict(request["headers"])
    if request.get("token"):
        headers["Authorization"] = "Bearer " + request["token"]
    wire = Request(request["url"], data=body or None, method=request["method"], headers=headers)
    try:
        response = build_opener(ProxyHandler({}), NoRedirect()).open(wire, timeout=2)
    except HTTPError as error:
        response = error
    try:
        data = response.read(request["max_bytes"] + 1)
        if len(data) > request["max_bytes"]:
            raise SystemExit(3)
        try:
            document = json.loads(data, parse_constant=_reject_json_constant) if data else {}
        except Exception:
            document = None
        result = {
            "status": response.code,
            "json": document,
            "headers": {
                "etag": response.headers.get("ETag"),
                "retry-after": response.headers.get("Retry-After"),
            },
        }
    finally:
        response.close()
    sys.stdout.buffer.write(json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
