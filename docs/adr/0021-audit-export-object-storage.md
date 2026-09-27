# ADR-0021: Audit exports in private object storage with presigned downloads

Status: Proposed (needs owner approval; real-AWS behaviour is unverified, see the end).

## Context

Stage 09e wrote each signed export to a local directory (`AUDIT_EXPORT_DIRECTORY`) and served it
through the API behind an HMAC download token. That is a reference design: it ties exports to one
host's disk, cannot scale across workers and API replicas, and streams customer data through the API.

## Decision

The worker still builds the export and signs the manifest with Ed25519 (unchanged). It then uploads
the export, its signature and the manifest to a private S3-compatible bucket and marks the job ready
only after each object is head-verified. Customers download through a presigned GET URL that the API
issues only after the existing authorization (tenant-bound, admin role, `audit_export` entitlement,
job ownership) and after re-reading the stored object metadata.

- Interface `ExportStorage { put, head, presignGet }` in `packages/audit`. Filesystem and S3
  implementations; S3 is selected when `AUDIT_EXPORT_S3_BUCKET` is set, and partial S3 settings fail startup.
- Key `tenants/<tenantId>/audit-exports/<jobId>/<file>`, UUID-validated, deterministic per job. A crash
  and retry overwrites the same objects; the manifest is written last as the commit marker.
- Server-side encryption on every upload (SSE-S3 `AES256`, or `aws:kms` with a configured key ID),
  fixed `Content-Disposition: attachment`, `ChecksumSHA256` on single-part uploads, tenant, job and
  SHA-256 in object metadata. The API refuses to presign an object whose metadata tenant, job or digest differs.
- TTL default and hard maximum 300 s; the URL signs the response-content-disposition override.
  Response: JSON `{url, expiresAt, sha256, manifestUrl, signatureUrl}`. Issuing a link is audited as `downloaded`.
- The filesystem backend keeps working: the HMAC route now reads the token from the
  `X-Download-Token` header (not the query string), hashes the file against the signed manifest before
  sending, and never sends unverified bytes.
- Bounded failure handling for both backends: 5 attempts, exponential backoff (60 s to 1 h), then a
  `failed` state with a bounded error; transient S3 errors are also retried in-process.

## Alternatives considered

- **Keep the filesystem.** Zero dependencies, but single-host, no shared storage between worker and API,
  no lifecycle/encryption controls. Kept only for local/dev.
- **Proxy bytes through the API.** Simple authorization at one place, but every large export ties up an API
  connection and doubles egress. Presigned URLs move the bytes off the API; the cost is that a leaked URL is
  a bearer credential for at most 300 s (mitigated: short TTL, never logged, fixed disposition, tenant re-check).
- **302 redirect instead of JSON.** Rejected: browsers cannot attach the bearer token to a cross-origin redirect
  target cleanly and the client needs the digest and manifest URL to verify.
- **SSE-KMS by default.** Stronger separation and audit of key use, but per-request KMS cost and a key policy per
  environment. SSE-S3 is the default; KMS is one variable away and is the recommended production choice once the
  key policy is agreed (decision for the owner).
- **Object Lock at upload.** Conflicts with deterministic overwrite on retry; lock after `ready` if legal retention requires it.

## Consequences

- Retention: exports expire after 7 days in the API; a bucket lifecycle rule removes the bytes after 8 days
  (audit retention itself is still open, D8). Versioning is on, so overwrites on retry leave one noncurrent version
  that lifecycle removes.
- Multipart uploads above 8 MiB carry per-part SHA-256 but a composite object checksum, so the metadata SHA-256 and
  the signed manifest are the end-to-end integrity proof; consumers must run `verify-audit-export`.
- Presigned URLs expire with the signer's temporary credentials if those expire sooner than the TTL.

## Needs a real AWS account to prove (UNVERIFIED locally)

IAM policies for the worker and control-plane roles and the deny-based bucket policy (`aws:PrincipalArn` semantics for
presigned requests); SSE-KMS behaviour and key policy; Block Public Access and `BucketOwnerEnforced`; presign behaviour
across regions (region-specific endpoints, `s3.amazonaws.com` redirects, clock skew); lifecycle and versioning timing;
S3-side `ChecksumSHA256` validation (proven against MinIO only); access-log query-string exposure.
