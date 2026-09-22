# Stage 00: architecture and archive validation

Status: architecture/scaffold complete; application implementation pending.

- Original source snapshots preserved: GrainGuard- `c00a3810897921a4bf4d1065014776ff45dbc044`, CarePulse `3c4b79688182fe5ee29baa0d106fc2536ea0c852`. Original checkouts are clean.
- Git mirrors and portable bundles passed integrity verification. Additional recoverable PR/Actions commit references bring the archive to 479 reachable commits.
- Historical evidence contains 393 selected manifest path/blob versions. Every one of the 368 catalog entries has a matching dependency disposition, with zero missing/extra/duplicate keys; the catalog hash matches its recorded provenance.
- The coverage matrix has 141 distinct requirement IDs, including the user's three independent ten-million-scale dimensions and production-readiness gates.
- `make check-plan` verifies local Markdown links, component READMEs, required chapters and catalog/disposition coverage. This is a document consistency check, not an application test suite.
- The capacity model reproduces the documented arithmetic: 2m illustrative API RPS; 100m illustrative devices; approximately 1.667m readings/s; 147.456 TB/day of logical 1-KiB event payload. Cell counts are unverified lower-bound forecasts, not infrastructure benchmarks.
- The proposed telemetry event schema and fixture parse as JSON. Peer review checked required fields, UUIDs, timestamp formats, integer-string bounds, trace IDs, cross-field identity and measurement limits with Python's standard library. **No complete JSON Schema validator was available or run.** Stage02 must add schema-engine and contract tests.
- Peer review corrected database ownership in the diagram, tenant-key wording, idle binding-feed freshness, BFF limits, mandatory historical-profile coverage, mobile/ML gates and delayed FIFO escalation semantics.
- No source application dependencies were installed, no original service tests or new application runtime tests were run, and no cloud resources were created. The new GreenGuard is not yet production-ready.

The archive contains all 877 enumerated Actions run records and 879 attempt job collections. Original console downloads returned 410/404; missing logs are explicitly recorded. REST and native GraphQL supplements preserve their separate provenance. See the parent archive summary for exact scope and access limits.
