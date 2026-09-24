# Projection builder

Read root AGENTS.md, docs/STAGE_05_PLAN.md section 2.1, FIRST_VERTICAL_SLICE.md
projection transaction and P01–P06, ADR-0005/0008/0009, then this service's README.

- Device and telemetry only; facility is a separate extension.
- All writes use one WithTenant transaction and forced RLS. Never bypass the inbox.
- Lock inbox identity, inventory stream, telemetry stream, gaps, latest in that order.
- Device deltas require contiguous versions; telemetry latest uses observed time
  then exact signed-bigint stream version. Do not erase historical binding fields.
- Never commit an offset before a database commit or acknowledged quarantine.
- Do not weaken NoResetOffset or source checkpoint monotonicity.
- Keep run(ctx, getenv), Kafka and database seams testable. No tenant metric labels.
- Run go vet ./... and go test -race -cover ./...; database skips are not RLS proof.
- Migration runner uses PROJECTION_MIGRATION_URL; runtime uses PROJECTION_DATABASE_URL.
- Do not commit/push without an explicit user request.
