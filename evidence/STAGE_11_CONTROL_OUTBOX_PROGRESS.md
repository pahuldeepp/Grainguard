# Stage 11 control-outbox heartbeat validation

Date: 2026-09-26. Live local development stack; checks were read-only except for the targeted connector config update and idempotent heartbeat-topic creation.

## Change

- Added a 30-second Debezium `heartbeat.interval.ms` and `heartbeat.action.query` to `infra/kafka/connectors/control-outbox.json`.
- Kept `message.prefix.exclude.list=.*`, so heartbeat logical messages do not leak into the domain outbox topic.
- Provisioned `__debezium-heartbeat.greenguard_control` (one partition, RF 1, compacted) because Kafka auto-creation is disabled.
- Applied the same config to the running `control-outbox` connector with a targeted Connect REST `PUT`; no database schema, replication slot, or offset was modified.

## Before

- Connector and task were RUNNING but the source offset/confirmed flush LSN had stopped advancing.
- Connect offset was at commit LSN `1/685A64A8`; PostgreSQL retained roughly 30 MB behind the current WAL position.
- The Connect container exposes no JMX endpoint, so Debezium source metrics were unavailable.

## After

- Connector and task remained RUNNING.
- First post-update sample: Connect source commit offset advanced to decimal `6076600784`; slot `confirmed_flush_lsn=1/6A3191D0`; retained WAL gap 967,160 bytes; internal heartbeat topic end offset 1.
- Second sample about 35 seconds later: source commit offset advanced to decimal `6077612960`; slot `confirmed_flush_lsn=1/6A4103A0`; retained WAL gap 15,224 bytes; heartbeat topic end offset 3.
- This confirms actual source-offset and replication-slot progress across consecutive heartbeat periods. It does not establish a production retention SLO or prove the slot exporter is deployed.

## Commands/checks

- Read Connect config/status/offsets through the REST API.
- Created and described the heartbeat topic through Kafka CLI.
- Sampled `pg_replication_slots.confirmed_flush_lsn`, `pg_current_wal_lsn()`, and `pg_wal_lsn_diff()` directly with read-only SQL.
- `git diff --check` passed after the targeted config change.
