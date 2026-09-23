# services/

Only `device-service` and `telemetry-ingest` contain code. Every other folder here is a README placeholder for a later stage.

Before implementing a placeholder service: read its `README.md`, its rows in `docs/COVERAGE_MATRIX.md`, its stage in `docs/IMPLEMENTATION_BACKLOG.md`, and the matching part of `docs/FIRST_VERTICAL_SLICE.md`. Add it to the root `package.json` workspaces or its own Go module, to `sonar-project.properties` sources and coverage paths, and to `scripts/coverage.mjs`, so it is gated at 100% from its first commit.
