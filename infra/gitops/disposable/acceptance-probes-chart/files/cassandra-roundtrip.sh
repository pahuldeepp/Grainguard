#!/bin/sh
# Compatibility entrypoint. All credential-bearing connections are made by
# the pinned Python driver with CERT_REQUIRED and DNS hostname validation.
set -eu
exec python3 /probe/cassandra-roundtrip.py
