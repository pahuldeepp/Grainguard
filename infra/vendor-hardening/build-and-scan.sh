#!/usr/bin/env bash
# Local review only; no registry writes, suppressions, or shared Trivy cache.
set -eEuo pipefail
[[ "$#" == 2 ]] || { echo 'usage: build-and-scan.sh OUTPUT_DIRECTORY UNIQUE_RUN_ID' >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
output=${1:?usage: build-and-scan.sh OUTPUT_DIRECTORY UNIQUE_RUN_ID}
run=${2:?a unique lowercase run identifier is required}
[[ "$run" =~ ^[a-z0-9][a-z0-9-]{7,60}$ ]] || { echo 'invalid unique run identifier' >&2; exit 2; }
[[ ! -e "$output" ]] || { echo 'output directory already exists; use a fresh identifier' >&2; exit 2; }
mkdir -p "$output" || exit 2
output=$(cd "$output" && pwd)
cache=$(mktemp -d "${TMPDIR:-/tmp}/gg-vendor-trivy.XXXXXX")
context=$(mktemp -d "${TMPDIR:-/tmp}/gg-vendor-build.XXXXXX")
trap 'rm -rf "$cache" "$context"' EXIT
stage=initialization
trap 'printf "{\"status\":\"operational_failure\",\"stage\":\"%s\"}\n" "$stage" > "$output/evidence-status.json"; exit 2' ERR
stage=fetch-apks
python3 "$here/fetch-apks.py" "$context/kafka"
stage=prepare-gosu
python3 "$here/prepare-gosu.py" "$context/cassandra"
# The scanner version and database metadata are evidence, never substitutes for scanning.
stage=scanner-version
trivy --version > "$output/trivy-version.txt"
failed=0
for name in kafka cassandra; do
  tag="gg-vendor-hardening-$run/$name:candidate"
  if docker image inspect "$tag" >/dev/null 2>&1; then
    echo "candidate tag already exists: $tag" >&2; exit 2
  fi
  build_context="$context/$name"
  if ! docker build --platform linux/arm64 --network none -f "$build_context/Dockerfile.$name" -t "$tag" "$build_context" > "$output/$name-build.log" 2>&1; then
    printf '{"status":"build_failed","candidate":"%s","scanRun":false}\n' "$name" > "$output/$name-status.json"
    exit 2
  fi
  stage="image-inspection:$name"
  docker image inspect "$tag" > "$output/$name-inspect.json"
  # --ignore-unfixed is the existing fixable HIGH/CRITICAL policy. No ignore files.
  # Distinct finding code separates a completed policy failure from scanner errors.
  # The wrapper still returns 1 for HIGH/CRITICAL findings and 2 for missing proof.
  scan_code=0
  trivy image --image-src docker --cache-dir "$cache" --timeout 15m \
    --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --ignorefile /dev/null \
    --format json --output "$output/$name-trivy.json" --exit-code 17 "$tag" \
    > "$output/$name-scan.log" 2>&1 || scan_code=$?
  if [[ "$scan_code" == 17 ]]; then
    failed=1
  elif [[ "$scan_code" != 0 ]]; then
    printf '{"status":"scanner_failed","candidate":"%s","scannerExitCode":%s}\n' "$name" "$scan_code" > "$output/$name-status.json"
    rm -f "$output/$name-trivy.json"
    exit 2
  fi
  test -s "$output/$name-trivy.json" || { echo "$name scan did not produce evidence" >&2; exit 2; }
done
stage=database-metadata
trivy --cache-dir "$cache" --version > "$output/trivy-version-after-scan.txt"
cp "$cache/db/metadata.json" "$output/trivy-db-metadata.json"
cp "$cache/java-db/metadata.json" "$output/trivy-java-db-metadata.json"
if ! python3 "$here/summarize-scans.py" "$output/kafka-trivy.json" "$output/cassandra-trivy.json" --inspection "$output/kafka-inspect.json" --service kafka --inspection "$output/cassandra-inspect.json" --service cassandra > "$output/findings.json.tmp"; then
  rm -f "$output/findings.json.tmp"
  printf '{"status":"invalid_scan_evidence"}\n' > "$output/evidence-status.json"
  exit 2
fi
mv "$output/findings.json.tmp" "$output/findings.json"
exit "$failed"
