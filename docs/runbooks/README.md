# docs/runbooks

Status: **planned scaffold; implementation not started**.

Stages: 11,14.

Technology: Operations procedures.

Responsibility: Incident, backlog, connector, restore and failover guidance with rehearsal evidence.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.

## Stage 07 saga runbooks

Alert rules: [saga-alerts.rules.yml](saga-alerts.rules.yml). Each alert links one runbook:
[saga stuck](saga-stuck.md), [repair_required backlog](saga-repair-required.md),
[lease churn](saga-lease-churn.md), [compensation backlog](saga-compensation-backlog.md),
[MQTT ack timeout](saga-mqtt-ack-timeout.md), [participant down](saga-participant-down.md).
They have not been rehearsed in an incident exercise (Stage 14).
