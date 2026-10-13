# Assistant runtime deployment contract

The private assistant runtime is the BFF, Knowledge API and its ingestion
workers, Model Gateway, and Grain Advisor. Build images from the repository
root so each Dockerfile can copy its service source:

```sh
docker build -f services/knowledge-service/Dockerfile -t greenguard/knowledge-api:local .
docker build --platform linux/amd64 -f services/knowledge-service/Dockerfile.indexer \
  -t greenguard/knowledge-indexer:local .
docker build -f services/knowledge-service/Dockerfile.parser -t greenguard/knowledge-parser:local .
docker build -f services/model-gateway/Dockerfile -t greenguard/model-gateway:local .
docker build -f services/model-gateway/Dockerfile.usage -t greenguard/model-gateway-usage:local .
docker build -f services/grain-advisor/Dockerfile -t greenguard/grain-advisor:local .
```

The indexer source build includes checksum-pinned kubectl 1.37.0 for Linux amd64;
its Kubernetes workload is scheduled only on amd64 nodes. The PDF sandbox
requires the owned `greenguard-parser-runsc` RuntimeClass and dedicated parser
node pool. Installation and invocation must pass the actual parser gate before
AI workloads start; offline render checks do not prove a working kernel runtime.

Knowledge API and model gateway listen on TCP 8080; Grain Advisor listens on
TCP 8088. All three expose `/healthz` for process liveness and `/readyz` for
dependency readiness. Knowledge checks PostgreSQL; Advisor checks PostgreSQL,
its configured Control Plane membership owner and Alerts readiness (plus its
optional checkpoint database); Model Gateway checks configured Redis and
PostgreSQL controls. Probe readiness from the cluster with bounded timeouts.
Model Gateway requires at least 150 seconds of
termination grace because its provider request drain is bounded at 120 seconds.

The authenticated BFF is the public entry point. It derives tenant identity
from the verified user principal and calls Knowledge with a bearer token plus
that server-derived tenant ID. Knowledge independently validates OIDC/JWKS,
resolves current membership from the Tenant Control Plane for each operation,
and enforces tenant RLS. Do not expose Knowledge,
Model Gateway, or Grain Advisor publicly. Grain Advisor accepts only delegated
short-lived BFF credentials, revalidates Control Plane membership, and calls
Alerts as the owning service before any alert action.

## Required wiring before a deployment can become ready

- BFF: `KNOWLEDGE_API_URL`; assistant-agent settings and delegated signing key;
  private URLs for model gateway, MCP gateway and Grain Advisor.
- Knowledge API: `KNOWLEDGE_DATABASE_URL`, OIDC issuer/audience/JWKS,
  authoritative `CONTROL_PLANE_URL` and `CONTROL_LOOKUP_TOKEN` (or the exact
  in-cluster URL with `CONTROL_PLANE_MESH_MTLS=true`), protected
  per-tenant gateway-token registry and namespace HMAC key, model IDs, Pinecone
  index/credential, S3 bucket/region/KMS key, and optional Redis URL.
- Indexer/parser workers: Kafka, database and restricted worker credentials;
  their own process roles and network policies. Do not run these with the API
  database role.
- Model Gateway: access binding file, controls file, Redis URL file, budget DSN
  file, provider URLs and separately protected Voyage/Anthropic key files.
  Production controls are mandatory; uncontrolled local mode is loopback-only.
- Grain Advisor: delegated issuer/JWKS, current Control Plane membership URL and
  service token, Advisor DSN, Alerts origin and dedicated Alerts service token.
  Durable LangGraph approval pause/resume additionally requires a separately
  provisioned checkpoint DSN and its explicit migration.
- PostgreSQL migrations and RLS roles/policies, authoritative Control Plane
  membership bootstrap, Pinecone
  index, object bucket/KMS policy, Kafka topics/ACLs, external OIDC egress, and
  secret rotation must be provisioned and verified before readiness is expected.

The service implementations and container build paths are present, and local
acceptance evidence is recorded in `evidence/RAG_ADMIN_LOCAL_ACCEPTANCE_2026-10-03.md`.
That evidence is not a cloud deployment. No Kubernetes charts, release wiring,
production secrets, external provider access, first-admin membership bootstrap,
or full Dex-to-BFF-to-approval-owner cloud acceptance is supplied by these service
images. Those remain deployment gates; a successful image build alone is not
evidence that the assistant is ready or that model actions can safely execute.

The Knowledge, Model Gateway and Grain Advisor sources, plus the two shared
policy files, were copied on 2026-10-04 from the local `ai-ml-foundation`
worktree at `588095879506d6df8af722441d3bc34b98760511`. Those paths were
untracked at that source HEAD, so the commit does not attest their contents.
The source worktree later diverged in eight files; its post-copy digest capture
is recorded in `evidence/assistant-source-manifest-2026-10-04.sha256`, and the
hashes for the exact files now delivered in this checkout are in
`evidence/assistant-target-runtime-manifest-2026-10-04.sha256`. No keys, local
databases, PDFs, logs, or Python bytecode were imported. The target repository
is the reviewable source of record for this scoped change.
