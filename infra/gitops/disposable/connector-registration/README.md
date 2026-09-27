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
