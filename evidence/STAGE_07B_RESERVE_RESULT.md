# Stage 07b reserve-result slice

The first participant-result transition is implemented in the saga database.
`asset.reserve` success records one command receipt, changes `reserving` to
`configuring`, queues `asset.configure`, and records `asset.reserved` audit in
one tenant-scoped transaction. The row lock serializes concurrent results; the
command's version and fencing token must match the current saga. The inbox has
a unique `(tenant_id, command_id)` constraint, so redelivery cannot create a
second definitive outcome.

Local evidence on 2026-09-24: `make saga-migrate saga-test` exited 0 against
`greenguard_sagas`. The live test covers a second tenant, a mismatched fencing token,
identical and new-result-ID redelivery, conflicting result ID reuse, two
concurrent results for one command, and exact one receipt/next command/audit.
`make verify` and `make coverage` passed. The local SonarQube gate passed with
89.4% overall/new coverage, 0.0% duplication, zero violations, and zero
security hotspots. CodeRabbit reviewed the new saga and CI-fix files with no
remaining findings after its suggestions were addressed. Remote CI is pending.

This is one transition, not the complete provisioning saga. Participant command
delivery and later steps remain open in `docs/STAGE_07_PLAN.md`.
