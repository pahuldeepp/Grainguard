# services/risk-engine

Python owner of `greenguard_risk`. Read [README.md](README.md) first; the outcome table there is the contract for offsets.

- Tests: `make risk-test` (uses `.local/risk-venv` from `requirements-dev.txt`). Live DB tests need `set -a; . ./.env; set +a` and `make risk-migrate`; they create random tenants and never delete.
- Coverage: `scripts/coverage.mjs` writes `services/risk-engine/coverage.xml` for SonarQube; keep non-test code at 100%.
- Migrations are forward-only: never edit an applied `migrations/*.up.sql` (the runner rejects a changed checksum); add a new numbered file and note the lock choice next to any new table.
- Never quarantine SQLSTATE 42501; never commit an offset for a not-ready or failed record; never derive `event_id` from anything but `(tenant, source_event_id, lot_id, policy_version)`.
- Keep functions at cognitive complexity 15 or less and avoid repeating a string literal more than 3 times (Sonar Python rules).
