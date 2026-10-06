# Stage 06 risk outbox-key regression — 2026-09-25

After the risk outbox-key changes in the current worktree, `node scripts/stage06-connect.mjs` exited 0 with both risk and alert connectors running. `node scripts/stage06-e2e.mjs` then exited 0 against the live local PostgreSQL, Kafka, RabbitMQ and notification stack.

The run observed two isolated tenants each progress from a canonical telemetry reading to risk assessment, CDC, alert, CDC, jobs intent, RabbitMQ and notification delivery. It also checked tenant-isolated acknowledgement and replay of the original `alert.opened` event after a jobs-worker SIGKILL/restart. [Connector output](stage-06/connect-2026-09-25.log) and [E2E output](stage-06/e2e-risk-key-2026-09-25.log) contain the raw result.

This is a local live regression, not a remote CI result or a production throughput measurement.
