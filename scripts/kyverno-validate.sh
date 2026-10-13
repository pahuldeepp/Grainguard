#!/usr/bin/env bash
set -euo pipefail

if ! command -v kyverno >/dev/null 2>&1; then
  echo "Kyverno CLI is required; install and verify it separately before running admission policy tests." >&2
  exit 127
fi

kyverno test infra/kyverno/tests --require-tests
