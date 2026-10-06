# Stage 09e object storage and export hardening: validation (2026-09-25)

Local only, against MinIO `RELEASE.2026-09-22T19-25-18Z` (Chainguard build,
`cgr.dev/chainguard/minio@sha256:bd014394a80898e68c149f2311fdf8d5a2c2f3bb2c33b9327ae6d02b4b065ae1`)
and the shared local Postgres. Design: [ADR-0021](../docs/adr/0021-audit-export-object-storage.md).
The image was pulled and its digest resolved with `docker buildx imagetools inspect`;
`minio/minio` (Docker Hub) and `quay.io/minio/minio` returned "pull access denied" / 401 anonymously.
Not run: `make sonar-*`, `make coverage`, `make verify`, saga/browser scripts.

## Commands and results

| Command | Result |
| --- | --- |
| `npm install -w @greenguard/audit --save-exact --ignore-scripts @aws-sdk/client-s3@3.1141.0 @aws-sdk/s3-request-presigner@3.1141.0 @aws-sdk/lib-storage@3.1141.0` | 0 vulnerabilities; `package-lock.json` diff against the pre-install copy has zero removed lines |
| `npm run test -w @greenguard/audit` | tests 34, pass 34, fail 0 |
| `npm run coverage -w @greenguard/audit` | all files 96.71% lines, 84.09% branches (storage.ts 94.58, storage-fs 97.16, storage-publish 97.14, storage-config 100, index 98.43) |
| `set -a; . ./.env; set +a; npm run test -w @greenguard/tenant-control-plane` | tests 111, pass 103, fail 0, skipped 8 (6 are the opt-in MinIO tests, 2 pre-existing) |
| `make audit-s3-test` (starts MinIO, creates the private bucket, builds, runs the live file) | tests 6, pass 6, fail 0 (below) |
| `npx eslint packages/audit/src services/tenant-control-plane/src infra/objectstore/init-bucket.mjs` | exit 0, no findings |
| `npx prisma migrate deploy` (only `20260925190000_audit_export_failures` was pending) | applied |

`make audit-s3-test` cases: S3X1 export -> upload -> head-verify -> presigned HTTP download; the
downloaded CSV, manifest and signature verify with the existing `verify-audit-export` CLI (exit 0),
a one-byte-longer file fails (exit 1), response carries `attachment` disposition and
`x-amz-server-side-encryption: AES256`. S3X2 a 1 s URL works, then returns 403 after 2.5 s.
S3X3 tenant A's URL with tenant B's tenant and job substituted, a zeroed signature, a raised
`X-Amz-Expires`, no query string, and a changed `response-content-disposition` all return 403.
S3X4 B's admin and A's admin get no links across tenants. S3X5 a child worker is SIGKILLed just
before the manifest upload (job stays `running`, objects are `audit.jsonl` and `signature` only); after
lease expiry a restart completes it with attempts 2, exactly three keys, and a further poll returns false.
S3X6 a 12 MiB file uploads multipart with SHA-256 and AES256 intact and downloads byte-identical.

Unit and DB tests added (test-first; the first run of each was a compile error for the missing module or
signature, then behavioural failures for the worker/quota tests): packages/audit `storage.test.ts` (S01-S09:
key layout, SSE headers, KMS switch, checksum mismatch, TTL cap 300, wrong-tenant metadata, listKeys),
`storage-publish.test.ts` (P01-P07 order, retry/backoff, no manifest after failure, head drift, F01-F02
filesystem), `storage-config.test.ts` (C01-C05 fail-closed config), `redaction.test.ts` (R01-R04 HMAC per tenant,
CSV neutralization, CLI round trip). tenant-control-plane: `s3-download.test.ts` (S3D1-5), `s3-config.test.ts`
(S3C1-3), `verified-file.test.ts` (V01-V04), `worker.storage.live.test.ts` (S3W1-6: failed upload never
completes, half-uploaded job recovers to one object set, backoff, cap of 5 attempts to `failed` with a bounded
error, lease-expiry poison job failed), `controller.storage.live.test.ts` (S3L1-4: nothing presigned before
authorization or for a foreign-tenant object), `controller.download.live.test.ts` (DL1-3: token in header,
altered file never sent), `export-request.live.test.ts` (EQ1-5: idempotent replay, key conflict, quota with
Retry-After, free default 0, concurrent requests cannot exceed the quota).

## Review findings closed here

Coordination items: correctness 9 (failure cap, `failed` state, backoff; Idempotency-Key and `exports.per_day`
through the shared `limit()` reader), correctness 11 and security 7 and 8 (file hashed before send, stream errors
handled without paths, CSV `'` prefix, per-tenant HMAC email pseudonyms, token moved to `X-Download-Token`).
Filesystem-backend tests `audit.live.test.ts` and `controller.test.ts` pass with only fixture changes (an
Idempotency-Key argument and a seeded `exports.per_day`).

## Observations

One earlier full-suite run showed `API key is tenant scoped, digest-only, and revocation denies next verify`
failing; it passed in isolation and in the next two full runs. It is outside this change and was not investigated.

## UNVERIFIED (needs a real AWS account)

Real S3 behaviour: IAM policies for the worker and control-plane roles, the deny-based bucket policy
(`infra/objectstore/bucket-policy.example.json`, including `aws:PrincipalArn` for presigned requests), Block Public
Access, SSE-KMS and its key policy, presign behaviour across regions, lifecycle and versioning timing, and S3-side
`ChecksumSHA256` validation (MinIO validates it; AWS not exercised). Not created or run: any cloud resource.
The pseudonym key is implemented and tested but not wired into the worker (it exports privileged rows).
Sonar duplication and cognitive-complexity gates were not run; literals repeated three or more times were checked by hand.
