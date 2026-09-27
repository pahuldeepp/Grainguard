#!/usr/bin/env bash
set -euo pipefail

fixture="tests/security/fixtures/insecure-pod.yaml"
report="$(mktemp)"
trap 'rm -f "$report"' EXIT

set +e
trivy config \
  --exit-code 1 \
  --severity HIGH,CRITICAL \
  --format json \
  --output "$report" \
  "$fixture"
scan_status=$?
set -e

if [[ ! -s "$report" ]]; then
  echo "Trivy did not produce a report; cannot distinguish scanner failure from a clean result" >&2
  exit 1
fi
if [[ "$scan_status" -ne 1 ]]; then
  echo "Expected Trivy to reject the deliberately insecure Kubernetes fixture (exit 1); got $scan_status" >&2
  exit 1
fi

python3 - "$report" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as report_file:
    report = json.load(report_file)

findings = [
    finding
    for result in report.get("Results", [])
    for finding in result.get("Misconfigurations", [])
    if finding.get("Status") == "FAIL"
    and finding.get("Severity") in {"HIGH", "CRITICAL"}
]
if not findings:
    raise SystemExit("Trivy exited nonzero but reported no high/critical misconfiguration finding")

print(f"Trivy rejected insecure fixture with {len(findings)} high/critical misconfiguration finding(s).")
PY
