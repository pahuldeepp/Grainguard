# packages/audit

Status: **Stage 09e foundation in progress**. `src/index.ts` exports an allowlisted
audit envelope, email redaction and Ed25519-signed JSONL manifest with SHA-256 file
and row-chain checks. `verify-audit-export FILE MANIFEST SIGNATURE PUBLIC_KEY_PEM`
checks a saved export without a signing key. `writeSignedAuditExport` streams ordered
tenant rows into a private staging directory and publishes the file, manifest and
signature with one rename. The package tests prove tamper rejection, cross-tenant row
refusal and partial-output cleanup. The tenant-scoped projection, authenticated API, durable asynchronous export
worker, signed download URL, owner-service adapters and live fault/tenant tests still
need implementation before Stage 09e can close.

Stages: 03,09.

Technology: Go/Node/Python, Postgres.

Responsibility: Durable audit envelopes and append-only storage adapters.

`npm test -w @greenguard/audit` runs the package tests. Completion requires runtime
wiring, live isolation and crash/retry evidence and reproducible local/CI commands.
Existing source reference archives live outside this fresh project.

## Object storage (Stage 09e, ADR-0021)

`ExportStorage { put, head, presignGet }` with `FilesystemExportStorage` (local/dev, legacy
`<root>/<jobId>/<file>` layout) and `S3ExportStorage` (AWS SDK v3, SSE-S3 or SSE-KMS, SHA-256
checksums, presigned GET capped at 300 s). `publishSignedExport` uploads export, signature, then
manifest, head-verifying each; `readS3StorageConfig` reads `AUDIT_EXPORT_S3_*` and fails closed on
partial settings. See `infra/objectstore/README.md`.

`redactAuditRow(row, false, {masterKey, keyId})` pseudonymizes email with an HMAC keyed per tenant
(`HMAC(master, "greenguard/audit-pseudonym/v1/<tenantId>")`); it throws without a key. Rotate by
deploying a new master key with a new `keyId`; pseudonyms from different key IDs must not be joined.
The export pipeline currently writes privileged (unredacted) rows, so no key is wired into the worker yet.
CSV cells starting with `=`, `+`, `-`, `@`, tab or CR get a leading `'` (formula injection).
