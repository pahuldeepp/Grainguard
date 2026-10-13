#!/bin/sh
set -eu
umask 077
trap 'curl -fsS -m 3 -X POST http://127.0.0.1:15020/quitquitquit >/dev/null 2>&1 || true' EXIT

root=/usr/share/opensearch
security="$root/config/opensearch-security"
mkdir -p /work/security
cp "$security"/*.yml /work/security/

hash_password() {
  "$root/plugins/opensearch-security/tools/hash.sh" -p "$1"
}
admin_hash="$(hash_password "$OPENSEARCH_ADMIN_PASSWORD")"
writer_hash="$(hash_password "$OPENSEARCH_WRITER_PASSWORD")"
reader_hash="$(hash_password "$OPENSEARCH_READER_PASSWORD")"
acceptance_writer_hash="$(hash_password "$OPENSEARCH_ACCEPTANCE_WRITER_PASSWORD")"
acceptance_reader_hash="$(hash_password "$OPENSEARCH_ACCEPTANCE_READER_PASSWORD")"
for hash in "$admin_hash" "$writer_hash" "$reader_hash" "$acceptance_writer_hash" "$acceptance_reader_hash"; do
  case "$hash" in '$2y$'*) ;; *) echo 'OpenSearch password hashing failed' >&2; exit 1 ;; esac
done

cat > /work/security/internal_users.yml <<EOF
_meta:
  type: internalusers
  config_version: 2
admin:
  hash: '$admin_hash'
  reserved: true
greenguard_writer:
  hash: '$writer_hash'
  reserved: true
greenguard_reader:
  hash: '$reader_hash'
  reserved: true
greenguard_acceptance_writer:
  hash: '$acceptance_writer_hash'
  reserved: true
greenguard_acceptance_reader:
  hash: '$acceptance_reader_hash'
  reserved: true
EOF

cat > /work/security/roles.yml <<'EOF'
_meta:
  type: roles
  config_version: 2
greenguard_admin:
  cluster_permissions: ['*']
  index_permissions:
    - index_patterns: ['*']
      allowed_actions: ['*']
greenguard_writer:
  cluster_permissions: []
  index_permissions:
    - index_patterns: ['greenguard-inventory-v*']
      allowed_actions: ['read', 'index', 'create_index']
greenguard_reader:
  cluster_permissions: []
  index_permissions:
    - index_patterns: ['greenguard-inventory-v*', 'greenguard-inventory']
      allowed_actions: ['read']
greenguard_acceptance_writer:
  cluster_permissions: []
  index_permissions:
    - index_patterns: ['greenguard-acceptance-probe-v1']
      allowed_actions: ['read', 'index', 'create_index', 'indices:data/write/delete', 'indices:admin/refresh']
greenguard_acceptance_reader:
  cluster_permissions: []
  index_permissions:
    - index_patterns: ['greenguard-acceptance-probe-v1']
      allowed_actions: ['read']
EOF

cat > /work/security/roles_mapping.yml <<'EOF'
_meta:
  type: rolesmapping
  config_version: 2
greenguard_admin:
  users: ['admin']
greenguard_writer:
  users: ['greenguard_writer']
greenguard_reader:
  users: ['greenguard_reader']
greenguard_acceptance_writer:
  users: ['greenguard_acceptance_writer']
greenguard_acceptance_reader:
  users: ['greenguard_acceptance_reader']
EOF

attempt=0
while [ "$attempt" -lt 45 ]; do
  attempt=$((attempt + 1))
  if "$root/plugins/opensearch-security/tools/securityadmin.sh" \
    -cd /work/security \
    -h greenguard-opensearch.greenguard.svc.cluster.local -p 9200 \
    -cacert /tls/ca.crt -cert /tls/admin.crt -key /tls/admin.key \
    -icl > /work/securityadmin.log 2>&1; then
    # Fixed, empty fixture index; exact scoped writer owns its creation.
    curl --fail --silent --show-error --cacert /tls/ca.crt \
      -u "greenguard_acceptance_writer:$OPENSEARCH_ACCEPTANCE_WRITER_PASSWORD" \
      -H 'Content-Type: application/json' -X PUT \
      'https://greenguard-opensearch.greenguard.svc.cluster.local:9200/greenguard-acceptance-probe-v1' \
      -d '{"mappings":{"properties":{"tenant_id":{"type":"keyword"},"marker":{"type":"keyword"}}}}' \
      > /work/fixture-index.json || {
        # Existing index is accepted only after an authenticated exact-index read.
        curl --fail --silent --show-error --cacert /tls/ca.crt \
          -u "greenguard_acceptance_reader:$OPENSEARCH_ACCEPTANCE_READER_PASSWORD" \
          'https://greenguard-opensearch.greenguard.svc.cluster.local:9200/greenguard-acceptance-probe-v1/_search?size=0' >/dev/null
      }
    echo 'OpenSearch security configuration initialized'
    exit 0
  fi
  sleep 5
done
echo 'OpenSearch security initialization failed after 45 attempts' >&2
tail -n 20 /work/securityadmin.log >&2
exit 1
