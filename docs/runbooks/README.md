# docs/runbooks

Status: **planned scaffold; implementation not started**.

Stages: 11,14.

Technology: Operations procedures.

Responsibility: Incident, backlog, connector, restore and failover guidance with rehearsal evidence.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.

The local alert route goes to a test webhook sink. Configure real contact points only in an authorized deployment environment after the sink behavior is verified.

## Stage 07 saga runbooks

Alert rules: [saga-alerts.rules.yml](saga-alerts.rules.yml). Each alert links one runbook:
[saga stuck](saga-stuck.md), [repair_required backlog](saga-repair-required.md),
[lease churn](saga-lease-churn.md), [compensation backlog](saga-compensation-backlog.md),
[MQTT ack timeout](saga-mqtt-ack-timeout.md), [participant down](saga-participant-down.md).
They have not been rehearsed in an incident exercise (Stage 14).

## Stage 12 local recovery procedures

[Disaster recovery](stage12-disaster-recovery.md) names restore prerequisites,
owner dependencies, integrity and tenant-isolation gates, and operator decisions.
Its repeatable local checks use synthetic PostgreSQL and injected recovery
fixtures. Service databases, managed backups, Kafka/Cassandra restore, measured
RPO/RTO and regional recovery remain unverified.

## Disposable AWS identity

[OIDC first-admin enrollment](disposable-oidc-first-admin.md) binds a
verified existing-provider access token to the first admin of a new tenant.
The real IdP, tenant membership, and web/iPhone login still require live
acceptance.
