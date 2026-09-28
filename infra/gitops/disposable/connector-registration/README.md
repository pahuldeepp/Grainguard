# Disposable Connect registration candidate

This chart is an offline candidate, not yet attached to the root Argo tree.
It uses an immutable Python image digest and an exact RDS DNS input. The Job
idempotently PUTs the eight checked-in Debezium connector configs into Connect,
replacing the Compose database hostname and requiring PostgreSQL
`verify-full` TLS with `/rds-ca/ca.pem` in the Connect worker. It then
requires each connector and every task to report RUNNING within nine minutes.
No password is included in the Job or ConfigMap; the connector configs use
Connect's environment provider for `CDC_DB_PASSWORD`.

Before wiring this chart, the Connect worker must mount the actual RDS CA at
`/rds-ca/ca.pem`, receive the synced database Secret, reach RDS through
NetworkPolicy and mesh policy, and use an image with the Debezium and Avro
plugins. The PostgreSQL publications/grants must already exist. A RUNNING
status still does not prove records flow, Schema Registry subjects exist, or
the downstream projections and alerts work. The broker is currently plain
TCP without Kafka SASL/ACL. Those are still deployment blockers. The image
digest must be published, supplied to this chart, and verified in live EKS.

Run `python3 -m unittest discover -s infra/gitops/disposable/connector-registration -p 'test_*.py'`
and `helm template connector-registration infra/gitops/disposable/connector-registration
--set image=example.com/python@sha256:<64 hex> --set rdsHost=db.example.com`
for offline checks.

## Approved legacy-central connector retirement

The optional `centralRetirementReceiptSecret` path is used only after source
writes are fenced, transfer/CDC verification is complete, and the legacy source
has zero remaining tenants. The receipt's exact bytes must match
`centralRetirementReceiptRevision` (SHA-256). The Job first validates the receipt,
then requires the new four-shard connectors to be healthy. This is a receipt
consumer, not a tenant-move implementation or an independent attestation of
those receipt assertions.

Retirement touches only the five operational central connector identities.
Central control, billing, and notification-contact streams are excluded. It
preflights existing connector host/database/user/slot/plugin identity and the
central slot catalog before mutation, sets `slot.drop.on.stop=true`, and deletes
the approved connector names. It then verifies PostgreSQL directly: only exact
allowlisted logical `pgoutput` slots in their expected databases can be dropped,
and only when inactive. Active slots receive bounded waiting; no backend is
terminated. Success requires both connector and slot absence. Missing tools,
wrong identity, an active/recreated slot, permission failures, or a failed query
leave retirement failed and resumable rather than reporting WAL release.

Receipt mode requires a digest-pinned registration image with **Python 3 and
`psql`**, the central CDC Secret (`credentialSecret`, key `CDC_DB_PASSWORD`),
`caSecret` (key `ca.pem`), and private `rdsCIDRs`. The credentials and CA are
mounted only for retirement; ordinary registration does not receive them.
`psql` uses `cdc_reader` against the exact central host with verified TLS,
bounded connection/statement/lock timeouts, and environment credentials. The
role must have the required replication-slot permissions. SQL command/error
output is withheld, and credentials are never placed in command arguments.
The chart renders DNS, Connect, Istio control-plane and bounded RDS egress.
The application-tree template forwards the optional receipt and central
credential/CA/CIDR values. These inputs, the script, connector configs and
Connect URL participate in the Job revision to avoid reusing completed Jobs.

Offline proof commands:

```sh
python3 -m unittest discover -s infra/gitops/disposable/connector-registration -p 'test_*.py'
ruby infra/gitops/disposable/connector-registration/test-retirement-chart.rb
```

Fixtures cover inactive slot cleanup, active-slot refusal, wrong connector or
slot scope before mutation, protected global streams, absent tools/CA,
credential-safe SQL errors, receipt-before-registration ordering, and conditional
Secret/TLS/network rendering. No AWS, PostgreSQL or Connect calls were executed
for these fixtures. Published dual-tool image delivery, actual RDS privileges,
Connect stop behavior, WAL release and mesh/network access still require live
acceptance.
