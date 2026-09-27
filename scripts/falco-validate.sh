#!/usr/bin/env bash
set -euo pipefail

if ! command -v falco >/dev/null 2>&1; then
  echo "Falco is required; install and verify it separately before validating or running runtime rules." >&2
  exit 127
fi

falco --validate infra/falco/greenguard_rules.yaml
