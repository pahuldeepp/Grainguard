# Disposable OpenSearch

This chart renders one private OpenSearch StatefulSet in `greenguard`, a
bounded security initialization Job, and an optional inventory index bootstrap
Job. All images are digest-pinned. The node uses a 1–100 GiB `gp3` EBS claim;
the Stage 12 teardown wrapper must remove the claim and released EBS volume
before destroying EKS. No public endpoint is created.

## Secrets and TLS

The guarded Secret sync must populate four Kubernetes Secrets before this
chart is enabled:

| Secret | Required keys |
| --- | --- |
| `greenguard-opensearch-tls` | `ca.crt`, `node.crt`, `node.key`, `admin.crt`, `admin.key` |
| `greenguard-opensearch-ca` | `ca.crt`, byte-identical to TLS Secret CA |
| `greenguard-opensearch-admin` | `password` |
| `greenguard-opensearch-clients` | `writer-password`, `reader-password` |

`node.crt` must chain to the CA, have server usage, and contain the exact DNS
SAN `greenguard-opensearch.greenguard.svc.cluster.local`. `admin.crt` must
chain to the same CA and have client usage. Both keys must be unencrypted
PKCS #8 PEM. The node init container checks these facts, certificate expiry, key
matches, and distinct node/admin certificate subjects. The verifier uses the
promoted search-indexer image, which includes OpenSSL. It writes a
`opensearch.yml` to a writable `emptyDir` file with certificate paths
relative to `/usr/share/opensearch/config` (`certs/node.crt`, `certs/node.key`,
`certs/ca.crt`). Only the node certificate, key, and CA mount into the server
container at that `certs` path; the admin private key is limited to the
certificate preflight and security initialization containers. The image demo
setup is disabled. A custom certificate is therefore mandatory.

OpenSearch readiness authenticates as admin and validates the service DNS
name with the CA. The probe pins that hostname to loopback, avoiding a
self-Service route through Istio. The Service publishes the unready pod address
only so the security initialization Job can reach it before authentication is
initialized; the job and probes must complete before downstream rollout. It
cannot become Ready from a TCP listener or a mismatched
certificate alone. Istio STRICT mTLS, NetworkPolicy, and exact service-account
AuthorizationPolicy restrict access inside EKS.

## Users, roles, and index

The security initialization Job uses the admin client certificate and the
three password values to load only `admin`, `greenguard_writer`, and
`greenguard_reader`. The writer role can read, index, and create only
`greenguard-inventory-v*`; the reader role can read that family and the
`greenguard-inventory` alias. The runtime profiles get passwords directly from
`greenguard-opensearch-clients`, with `greenguard_writer` for search-indexer
and `greenguard_reader` for read-api. Neither runtime gets the admin password.

Set `bootstrap.image` to a promoted digest of the updated search-indexer image
for TLS verification. Set `bootstrap.enabled=true` to also create the bounded
inventory Job. That Job creates
`greenguard-inventory-v1` idempotently, then compares the stored strict mapping
to the source mapping. A mismatch fails the Job. Alias promotion remains a
later manifest-checked operation.

Both Jobs request the Istio sidecar to exit through the local `quitquitquit`
endpoint when the main process exits. Argo Job completion with the selected
Istio/EKS versions still requires live proof; a non-terminating sidecar leaves
the Application unhealthy.

Offline check:

```sh
ruby infra/helm/greenguard-opensearch/check-contract.rb
```

## Remaining integration proof

Parent Terraform/Argo wiring must create and synchronize the four Secret
sources, pin both image digests, set both runtime `ELASTICSEARCH_URL` values to
`https://greenguard-opensearch.greenguard.svc.cluster.local:9200`, and order
security initialization and mapping bootstrap before the read-api and
search-indexer rollout. The TypeScript client uses `NODE_EXTRA_CA_CERTS` at
Node startup; both clients fail closed on incomplete HTTPS credentials.
Confirm real OpenSearch startup, security initialization, index bootstrap,
tenant-filtered reads, live web/mobile search, Job completion, and EBS cleanup
in the disposable AWS account. A chart render alone proves none of these.
