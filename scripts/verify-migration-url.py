"""Fail closed on disposable RDS owner URLs without verified TLS."""

import os
import re
import sys
from urllib.parse import parse_qs, urlparse


def valid(key: str, value: str | None) -> bool:
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*_MIGRATION_URL", key):
        return False
    try:
        parsed = urlparse(value or "")
        query = parse_qs(parsed.query)
        return (
            parsed.scheme in {"postgres", "postgresql"}
            and bool(parsed.hostname)
            and bool(parsed.username)
            and bool(parsed.path.lstrip("/"))
            and query.get("sslmode") == ["verify-full"]
            and query.get("sslrootcert") == ["/rds-ca/ca.pem"]
        )
    except ValueError:
        return False


if __name__ == "__main__":
    key = sys.argv[1] if len(sys.argv) == 2 else ""
    if not valid(key, os.environ.get(key)):
        print("Migration URL must be a direct PostgreSQL owner URL with verified RDS TLS", file=sys.stderr)
        raise SystemExit(1)
