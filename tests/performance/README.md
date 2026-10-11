# tests/performance

Status: **local authenticated HTTP-to-PostgreSQL rate sweep recorded; full Stage 13 certification remains unimplemented**.

Stages: 13.

Technology: k6, profilers.

Responsibility: Reproducible load/soak and resource budgets.

`telemetry-ingest.js` is an open-arrival-rate HTTP workload for the real authenticated
`POST /v1/devices/{deviceId}/readings` endpoint. It records offered/completed rate,
latency, rejected responses, and dropped iterations. It does not itself prove Kafka,
CDC, projections, Cassandra, alerts, or the end-to-end freshness/durability SLOs.

The fixture JSON must remain local and contain tenant-scoped operator tokens plus
bound device IDs, for example:

```json
{
  "tenants": [
    { "bearer_token": "<short-lived-token>", "device_ids": ["<bound-device-uuid>"] }
  ]
}
```

Build a dedicated synthetic tenant/device fixture first. Tokens must be short-lived,
have only the required ingest role, and never be committed or placed in command-line
arguments. The test creates unique reading IDs; these are durable test writes and
must only target a dedicated local/disposable environment.

Local authenticated baseline (loopback only):

```sh
GG_PERF_LOCAL_ACK=I_ACCEPT_WRITING_LOCAL_SYNTHETIC_READINGS \
RATE=10 DURATION=30s PREALLOCATED_VUS=32 MAX_VUS=128 \
make perf-ingest-local
```

`perf-ingest-local` checks that the configured `TELEMETRY_DIRECT_URL` and
`POSTGRES_ADMIN_URL` point to the same loopback PostgreSQL port, creates a random
tenant with 256 bound devices, bootstraps tenant placement through the local
placement fixture, and starts telemetry-ingest with a temporary loopback JWKS
issuer. The generated operator token and registry files are mode 0600 in a
temporary directory. It deletes every public telemetry row for that random tenant
and its ownership row after the run. The database itself must be a disposable local
GreenGuard environment; the guard prevents non-loopback targets but cannot identify
whether a local database contains user data.

The harness trusts only the loopback peer and asks k6 to send synthetic client
addresses from the RFC 2544 benchmarking range, with a hard cap of 65,024 VUs so
the generated address remains inside `198.18.0.0/15`. This exercises the trusted-proxy
per-source admission path instead of measuring the default 10 requests/second
single-peer fallback. This header simulation is local-only and does not test the
actual gateway's forwarded-header behavior; production must set trusted proxy CIDRs
to real ingress peers and verify that ingress overwrites or appends the client
address correctly.

The resulting `evidence/performance/local-telemetry-ingest-*.json` reports accepted
rate, request rate, HTTP p95 and threshold results. This measures the authenticated
HTTP-to-PostgreSQL transaction path only. It disables the binding-feed freshness
gate and does not run Kafka, CDC, projections, Cassandra or alerts, so it cannot
certify the end-to-end freshness, durability or SLO targets. Keep the rate modest
for the first baseline, then increase it deliberately; do not treat this single-host
test as evidence for 20k/s or 50k/s fleet capacity.

The initial 100–500/s local rate sweep and its interpretation are recorded in
[`evidence/performance/LOCAL_RATE_SWEEP_2026-10-10.md`](../../evidence/performance/LOCAL_RATE_SWEEP_2026-10-10.md).
The 250/s sample was accepted for 30 seconds; latency degraded at 300/s and the
500/s sample failed the acceptance thresholds with p95 at 716 ms. These are short measurements,
not a stable capacity limit or evidence that batching is the right fix.

Disposable HTTPS execution additionally requires `GREENGUARD_LOAD_TARGET=disposable`,
`EXPECTED_BASE_URL` exactly equal to `BASE_URL`, and
`GREENGUARD_LOAD_ACK=I_ACCEPT_WRITING_SYNTHETIC_READINGS`. Start with low rates,
confirm the account/region/cluster and fixture ownership, and scale the generator
separately so it does not become the bottleneck. The script refuses non-loopback
local URLs and refuses disposable runs without those explicit checks.

The current 20k/s sustained and 50k/s peak goals require a distributed generator,
realistic many-tenant/device fixtures, and the full downstream pipeline. This single
HTTP scenario is a first measurement step, **not** that certification. Telemetry
ingest latency is reported but has no approved numeric SLO yet. Stage 13 still needs
the Kafka/CDC/projection/Cassandra/alert correlation harness, soak, fault, and
durability/reconciliation evidence. Do not enable batching or increase partition
counts solely from a synthetic throughput result; compare correctness, lag, and
freshness at the same offered load.
