# ADR-0024: AWS as the production platform

Status: Accepted (owner, 2026-09-29; supersedes an earlier same-day GCP draft) · Date: 2026-09-29

## Context

GreenGuard's delivery plan and infra READMEs (`infra/terraform`, `infra/cdk`, `infra/objectstore`, Stage 10b) already lean on AWS: EKS, MSK, S3, CDK, Lambda, EventBridge, DynamoDB. GreenGuard Intelligence ([ADR-0023](0023-intelligence-track.md)) needs a Kubernetes platform with a sandboxed runtime, scale-to-zero GPU pools, managed Postgres with pgvector and logical replication, and object storage. Choosing AWS keeps one cloud and is consistent with the planned AWS direction of the infra plan. No AWS deployment acceptance exists yet: `infra/*` is scaffolded only, and Stage 10b has local DynamoDB Local and CDK synth evidence only.

## Decision

The whole platform's production target is **Amazon Web Services**. Service mapping:

| Concern | AWS choice | Notes |
|---|---|---|
| Kubernetes | Amazon EKS (one region, multi-AZ in prod, single-AZ staging), managed node groups or Karpenter | Node pools: app, GPU, sandboxed workloads |
| Sandboxed runtime | **gVisor (`runsc`) installed on a dedicated tainted node group** via custom AMI/containerd runtime class (there is no managed gVisor on EKS) | Firecracker/Kata on bare-metal nodes remains the documented hardening path |
| GPU | `g6.xlarge` (1× NVIDIA L4) on Spot via Karpenter, scale to zero; `g6e`/`p4d` only if measured need | NVIDIA device plugin; capacity is not guaranteed on Spot — On-Demand fallback pool defined in I13 |
| Postgres | Amazon RDS for PostgreSQL (Multi-AZ in prod), pgvector extension; PgBouncer stays in-cluster | Logical replication enabled for Debezium (`rds.logical_replication`) |
| Kafka | Amazon MSK (Provisioned or Serverless) for prod; Strimzi in-cluster for local/demo | MSK Connect or Debezium on EKS; Schema Registry per ADR-0010 (Glue Schema Registry is not the contract source) |
| Object storage | Amazon S3 with versioning and lifecycle. **One KMS CMK per environment with S3 Bucket Keys** (not one KMS key per tenant — that costs about $1/key-month and hits key quotas at 10k+ orgs); per-tenant separation is by tenant-pseudonym prefix, and per-tenant DEK envelope encryption (R23) is done by the application for content it stores | S3 Object Lock is not used for tenant data (Intelligence R6). **Audit exports follow ADR-0021** (SSE-S3 default, `aws:kms` optional, tenant-prefixed lifecycle) until that ADR is accepted; crypto-shred (R26) must be checked against its 7/8-day export retention. |
| Keys and secrets | AWS KMS (per-environment CMK), Secrets Manager; per-tenant DEKs per Intelligence R23 | |
| Redis | Amazon ElastiCache for Redis (cluster mode) | |
| Search | Amazon OpenSearch Service (managed) for prod; single-node container locally | Telemetry search only (Stage 05d/10a). Knowledge vectors are **not** in OpenSearch: they are in Pinecone ([ADR-0029](0029-pinecone-knowledge-vector-store.md)), a third-party managed service on AWS, so it appears in the subprocessor list, not in this AWS mapping |
| Cassandra | Amazon Keyspaces evaluated at Stage 13; self-managed Cassandra (K8ssandra) on EKS for the demo | |
| RabbitMQ | Amazon MQ for RabbitMQ or the RabbitMQ Cluster Operator | |
| Edge | ALB/NLB + AWS WAF + Shield | Review gap O4 |
| Identity to AWS | EKS Pod Identity | No long-lived keys; sandbox pods get no AWS identity |
| IaC and delivery | Terraform (AWS provider) for cloud resources; Helm; Argo CD; Argo Rollouts. CDK remains for the Stage 10b serverless profile | |
| Image trust | ECR with image scanning; Cosign signatures verified by a Kyverno admission policy | |
| ML platform | MLflow on EKS (backend RDS, artifacts S3); orchestration Argo Workflows; SageMaker is optional, not required | |
| LLM | Anthropic first-party API (owner decision 2026-09-29); **Claude on Amazon Bedrock** is the optional second channel. It is **not** a region-pinning channel for Sonnet 5.5 (only the `global.` inference profile is listed); data residency is evaluated separately (first-party `inference_geo`, Claude Platform on AWS) under owner question O3 | Bedrock model IDs and feature parity (thinking, prompt caching, tool use, `fallbacks`) must be verified against current docs before enabling — gateway adapter treats it as a separate provider with its own capability table |

The Stage 10b serverless profile (DynamoDB flags, CDK/Lambda/SQS/EventBridge bridge) stays in place, unchanged, and is no longer in conflict with the platform target.

## Consequences

- Stage 12 (Terraform, EKS, Helm, GitOps) and Intelligence I13 are planned for AWS. The GCP references in earlier Intelligence drafts are mapped by [docs/intelligence/README.md](../intelligence/README.md) §2.5 R29.
- Cost and capacity models are recomputed with AWS prices in I0 and verified at I13; spot capacity for L4 GPUs must be measured, not assumed.
- Managed gVisor is not available, so the sandbox node group (custom AMI, runtime class, upgrade cadence) is a maintained artifact with its own tests (escape/egress suite re-run per AMI, Intelligence I10/I13).
- On RDS the CDC role is `rds_replication` (not the REPLICATION attribute), so the review R1/H2 privilege test is redone there, and WAL/slot-lag alerts (review H3) are re-mapped to CloudWatch metrics — both are Stage 12 and I13 exit items.
- Anthropic on Bedrock has different rate limits, model IDs and residency; recorded per provider in gateway config.
