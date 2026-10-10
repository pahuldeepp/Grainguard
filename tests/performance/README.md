# tests/performance

Status: **first executable ingest load scenario added; full Stage 13 certification remains unimplemented**.

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

Local smoke (loopback only):

```sh
GREENGUARD_LOAD_TARGET=local \
BASE_URL=http://127.0.0.1:8080 \
FIXTURES_FILE=/secure/local/path/greenguard-load-fixtures.json \
RATE=5 DURATION=30s PREALLOCATED_VUS=20 MAX_VUS=100 RUN_ID=local-smoke-001 \
k6 run tests/performance/telemetry-ingest.js
```

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
