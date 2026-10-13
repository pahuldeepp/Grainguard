#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT
mkdir -p "$temp/tls" "$temp/ca" "$temp/config"
chmod 0777 "$temp/config"

openssl req -x509 -newkey rsa:2048 -nodes -days 2 -sha256 \
  -subj '/CN=GreenGuard disposable test CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -keyout "$temp/ca.key" -out "$temp/ca/ca.crt" >/dev/null 2>&1
cp "$temp/ca/ca.crt" "$temp/tls/ca.crt"

make_cert() {
  local name="$1" subject="$2" extension="$3"
  openssl req -new -newkey rsa:2048 -nodes -sha256 \
    -subj "/CN=$subject" \
    -keyout "$temp/$name-rsa.key" -out "$temp/$name.csr" >/dev/null 2>&1
  openssl x509 -req -days 2 -sha256 -in "$temp/$name.csr" \
    -CA "$temp/ca/ca.crt" -CAkey "$temp/ca.key" -CAcreateserial \
    -extfile "$extension" -out "$temp/tls/$name.crt" >/dev/null 2>&1
  openssl pkcs8 -topk8 -nocrypt -in "$temp/$name-rsa.key" \
    -out "$temp/tls/$name.key" >/dev/null 2>&1
}

cat > "$temp/node.ext" <<'EOF'
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:greenguard-opensearch.greenguard.svc.cluster.local
EOF
cat > "$temp/admin.ext" <<'EOF'
basicConstraints=CA:FALSE
keyUsage=digitalSignature
extendedKeyUsage=clientAuth
EOF
make_cert node greenguard-opensearch "$temp/node.ext"
make_cert admin greenguard-admin "$temp/admin.ext"

helm template greenguard-opensearch "$root/infra/helm/greenguard-opensearch" \
  --namespace greenguard \
  --set "image=opensearchproject/opensearch@sha256:$(printf 'a%.0s' {1..64})" \
  --set "bootstrap.image=example/search-indexer@sha256:$(printf 'b%.0s' {1..64})" \
  > "$temp/render.yaml"
ruby -ryaml -e 'o=YAML.load_stream(File.read(ARGV[0])).compact.find{|x|x["kind"]=="StatefulSet"}; print o.dig("spec","template","spec","initContainers",0,"args",0)' \
  "$temp/render.yaml" > "$temp/preflight.sh"

docker run --rm --user 1000:1000 --entrypoint /bin/sh \
  -v "$temp/tls:/tls:ro" -v "$temp/tls:/admin:ro" -v "$temp/ca:/ca:ro" \
  -v "$temp/config:/config" -v "$temp/preflight.sh:/preflight.sh:ro" \
  greenguard/search-indexer:stage12-local -e /preflight.sh >/dev/null
grep -q 'plugins.security.ssl.http.pemcert_filepath: certs/node.crt' "$temp/config/opensearch.yml"

cp "$temp/tls/node.crt" "$temp/good-node.crt"
cp "$temp/tls/node.key" "$temp/good-node.key"
expect_rejected() {
  if docker run --rm --user 1000:1000 --entrypoint /bin/sh \
    -v "$temp/tls:/tls:ro" -v "$temp/tls:/admin:ro" -v "$temp/ca:/ca:ro" \
    -v "$temp/config:/config" -v "$temp/preflight.sh:/preflight.sh:ro" \
    greenguard/search-indexer:stage12-local -e /preflight.sh >/dev/null 2>&1; then
    echo "unsafe certificate fixture was accepted: $1" >&2
    exit 1
  fi
}
sed 's/greenguard-opensearch.greenguard.svc.cluster.local/wrong.example.test/' "$temp/node.ext" > "$temp/wrong.ext"
make_cert node wrong.example.test "$temp/wrong.ext"
if openssl verify -purpose sslserver -verify_hostname greenguard-opensearch.greenguard.svc.cluster.local -CAfile "$temp/ca/ca.crt" "$temp/tls/node.crt" >/dev/null 2>&1; then
  echo 'negative fixture has the expected service SAN' >&2
  exit 1
fi
expect_rejected wrong-san
cp "$temp/good-node.crt" "$temp/tls/node.crt"
cp "$temp/tls/admin.key" "$temp/tls/node.key"
expect_rejected wrong-private-key
cp "$temp/good-node.key" "$temp/tls/node.key"
printf '\n' >> "$temp/tls/ca.crt"
expect_rejected ca-mismatch
echo 'OpenSearch TLS preflight: matching certificate accepted; wrong SAN, key and CA rejected'
