# infra/objectstore

Object storage for Stage 09e audit exports. Nothing here creates cloud resources.

- `compose.yaml`, `init-bucket.mjs`: an opt-in local S3-compatible store (MinIO) for
  `make audit-s3-test`. Local proof only: HTTP on `127.0.0.1:59000`, throwaway credentials from
  the ignored `.env` (`make bootstrap` generates `OBJECTSTORE_*`), never part of `make verify`.
- `bucket-policy.example.json`: a bucket policy to adapt for a real bucket (placeholders only).

```bash
make objectstore-up      # start MinIO (256 MB limit) and create the private test bucket
make audit-s3-test       # live test: export -> upload -> presigned download -> Ed25519 verify
make objectstore-down    # stop only the MinIO container
```

The image is `cgr.dev/chainguard/minio`, pinned by digest (MinIO `RELEASE.2026-09-22T19-25-18Z`).
The upstream `minio/minio` (Docker Hub) and `quay.io/minio/minio` images could not be pulled
anonymously on 2026-09-25, so a maintained build of the same server is used for local proof.

## Configuration (worker and API)

S3 is used when `AUDIT_EXPORT_S3_BUCKET` is set; otherwise the filesystem directory backend.
Bucket and region must be set together; any other partial `AUDIT_EXPORT_S3_*` set fails at startup.

| Variable | Purpose |
| --- | --- |
| `AUDIT_EXPORT_S3_BUCKET`, `AUDIT_EXPORT_S3_REGION` | required together |
| `AUDIT_EXPORT_S3_ENDPOINT`, `AUDIT_EXPORT_S3_FORCE_PATH_STYLE` | S3-compatible stores; https unless loopback |
| `AUDIT_EXPORT_S3_ACCESS_KEY_ID`, `AUDIT_EXPORT_S3_SECRET_ACCESS_KEY` | local only, both or neither; production uses the AWS provider chain (IAM role) |
| `AUDIT_EXPORT_S3_KMS_KEY_ID` | switches SSE-S3 (`AES256`) to SSE-KMS (`aws:kms`) |
| `AUDIT_EXPORT_S3_PRESIGN_TTL_SECONDS` | default and hard maximum 300 |

## Layout and integrity

`tenants/<tenantId>/audit-exports/<jobId>/{audit.jsonl|audit.csv, signature, manifest.json}`.
Both IDs are UUID-validated; the key is deterministic per job so a retry overwrites the same
objects. Upload order is export, signature, then the manifest (the commit marker); the job is marked
ready only after each object is head-verified (size, SHA-256 metadata, tenant and job metadata).
Single-part objects also carry an S3-verified `ChecksumSHA256`. Objects above 8 MiB use multipart
upload (per-part SHA-256; the composite object checksum is not the file hash, so the metadata
SHA-256 and the signed manifest are the end-to-end proof). Every object is uploaded with
server-side encryption, a fixed `attachment` `Content-Disposition`, and tenant, job and SHA-256 as
object metadata. Before issuing a download URL the API re-reads that metadata and refuses any object
whose stored tenant, job or digest differs.

## Bucket hardening checklist (real S3, done outside this repo)

1. Block Public Access on (all four settings), ACLs disabled (`BucketOwnerEnforced`).
2. Bucket policy from `bucket-policy.example.json`: deny non-TLS, deny unencrypted uploads, deny
   writes except the worker role, deny reads except the worker and control-plane roles.
3. Default encryption SSE-S3, or SSE-KMS with a customer-managed key; the key policy allows only the
   worker (encrypt) and the control-plane role (decrypt for presigned reads).
4. Versioning on. Lifecycle: expire current objects 8 days after creation (exports expire in the API
   after 7 days) and noncurrent versions after 1 day. Match your audit retention decision (D8).
5. Optional Object Lock in governance mode only if legal retention requires it; it conflicts with
   deterministic overwrite on retry, so lock after the job is `ready` (a follow-up), not at upload.
6. Access logging to a separate log bucket. Presigned URLs are bearer credentials: the API never logs
   them; do not forward S3 access logs (which contain the query string) to shared sinks unredacted.
7. IAM: worker role `s3:PutObject` and `s3:GetObject` on `tenants/*/audit-exports/*`; control-plane
   role `s3:GetObject` (presign signer) and `s3:ListBucket` only if listing is needed. No other principals.
   A presigned URL is signed with the API role's credentials and stops working when those temporary
   credentials expire, so its real lifetime is at most the TTL.
