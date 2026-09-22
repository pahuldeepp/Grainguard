# GreenGuard dependency disposition

All **368 catalog entries** have a named destination, phase and role. **345 current**, **23 historical-only**, **0 unclassified**, **0 missing**, **0 duplicated**. These are proposed implementation dispositions, not installation or runtime completion claims.

Use [the source technology catalog](TECHNOLOGY_CATALOG.md) for original versions and [the JSON disposition](DEPENDENCY_DISPOSITION.json) for exact joins, source paths, available current declaration evidence, notes and machine-checkable coverage. The [rebuild blueprint](REBUILD_BLUEPRINT.md) defines service ownership and the [implementation backlog](IMPLEMENTATION_BACKLOG.md) defines acceptance milestones.

## Reading and compatibility rules

- Current means declared in at least one archived current repository manifest; it does not mean supported, secure, installed or operational.
- Historical means absent from all catalog current_repositories; every recorded version and source association remains in TECHNOLOGY_CATALOG.json.
- Phase is the primary adoption/verification milestone, not the only phase that may use the capability; prerequisite contracts/tooling may be introduced earlier.
- Destinations are proposed ownership labels and profile names; their assignment is not proof of implemented code or deployed resources.
- No version is approved here. Select one compatible supported baseline per runtime/profile, resolve indirect dependencies, pin lockfiles/actions/images, and run the relevant compatibility/security checks during implementation.
- Original manifests aggregate direct, development, indirect, resource-type, container and action records. These 368 entries are not 368 application packages to install.
- Go module families are classified from recorded module names and source paths. Current direct/indirect declarations are also preserved where a current local manifest exists; that evidence does not establish every historical dependency edge.
- The source catalog aggregates versions per name and does not map every version to current/historical individually. This file does not invent that mapping.
- Technologies described only in prose, code imports or future architecture are covered separately by COVERAGE_MATRIX.md; this disposition covers exactly the 368 machine-readable catalog entries.
- No dependency installation, cloud provisioning, notification or external tool connection occurs when reading or checking this plan.

**84 Go entries** are marked indirect in every available current declaration found. They belong to a selected dependency graph and are not an instruction to add direct `require` statements.

Historical variants, floating tags and incompatible major versions remain evidence. Examples requiring explicit baseline work include Express 4/5 types, Jest 29/30 versus ts-jest 29, react-window 2 versus its archived v1 declarations, Vite beta, multiple OpenTelemetry families and registry tags such as `latest`/`master`. No claim of current compatibility or latest release versions is made.

## Phase coverage

| Phase | Primary milestone | Entries |
| --- | --- | ---: |
| 01 | foundation | 54 |
| 02 | contracts | 16 |
| 03 | outbox | 52 |
| 04 | CDC | 13 |
| 05 | CQRS | 17 |
| 06 | risk | 5 |
| 07 | saga | 14 |
| 08 | BFF/UI | 63 |
| 09 | SaaS | 26 |
| 10 | interoperability | 2 |
| 11 | observability | 48 |
| 12 | delivery | 48 |
| 13 | scale | 2 |
| 14 | operations | 8 |

A phase with zero catalog entries still has architecture and operational work. Phase ownership does not replace scenario, failure-mode or acceptance coverage.

## Entry-by-entry ownership

`current` and `historical` describe source evidence. A destination beginning `profiles/` is an isolated comparison/runtime profile. Other destinations name an owning service, shared package, infrastructure component or developer/test tool. Every row is compatibility gated; JSON records the more specific adoption mode.

### GitHub Action

| ID | Catalog name | Category | Phase | Destination | Role |
| --- | --- | --- | --- | --- | --- |
| DEP-001 | `./.github/workflows/ci.yml` | historical | 12 | `tools/ci-delivery` | Historical reusable workflow call reference; rewrite and validate GreenGuard workflow contract |
| DEP-002 | `actions/checkout` | current | 01 | `tools/ci-foundation` | CI checkout, language setup or lint gate for reproducible builds |
| DEP-003 | `actions/github-script` | current | 12 | `tools/ci-delivery` | CI workflow action with least-privilege permissions and immutable verified pin |
| DEP-004 | `actions/setup-go` | current | 01 | `tools/ci-foundation` | CI checkout, language setup or lint gate for reproducible builds |
| DEP-005 | `actions/setup-node` | current | 01 | `tools/ci-foundation` | CI checkout, language setup or lint gate for reproducible builds |
| DEP-006 | `actions/setup-python` | current | 01 | `tools/ci-foundation` | CI checkout, language setup or lint gate for reproducible builds |
| DEP-007 | `actions/upload-artifact` | current | 12 | `tools/ci-delivery` | CI workflow action with least-privilege permissions and immutable verified pin |
| DEP-008 | `anchore/sbom-action` | current | 12 | `tools/ci-security-quality` | Static analysis, image/dependency scanning, SBOM or quality gate; fail on skipped required checks |
| DEP-009 | `aquasecurity/trivy-action` | current | 12 | `tools/ci-security-quality` | Static analysis, image/dependency scanning, SBOM or quality gate; fail on skipped required checks |
| DEP-010 | `aws-actions/configure-aws-credentials` | current | 12 | `tools/ci-delivery` | CI workflow action with least-privilege permissions and immutable verified pin |
| DEP-011 | `azure/setup-kubectl` | current | 12 | `tools/ci-delivery` | CI workflow action with least-privilege permissions and immutable verified pin |
| DEP-012 | `docker/build-push-action` | current | 12 | `tools/ci-delivery` | CI workflow action with least-privilege permissions and immutable verified pin |
| DEP-013 | `docker/login-action` | current | 12 | `tools/ci-delivery` | CI workflow action with least-privilege permissions and immutable verified pin |
| DEP-014 | `docker/metadata-action` | current | 12 | `tools/ci-delivery` | CI workflow action with least-privilege permissions and immutable verified pin |
| DEP-015 | `docker/setup-buildx-action` | current | 12 | `tools/ci-delivery` | CI workflow action with least-privilege permissions and immutable verified pin |
| DEP-016 | `github/codeql-action/analyze` | current | 12 | `tools/ci-security-quality` | Static analysis, image/dependency scanning, SBOM or quality gate; fail on skipped required checks |
| DEP-017 | `github/codeql-action/autobuild` | current | 12 | `tools/ci-security-quality` | Static analysis, image/dependency scanning, SBOM or quality gate; fail on skipped required checks |
| DEP-018 | `github/codeql-action/init` | current | 12 | `tools/ci-security-quality` | Static analysis, image/dependency scanning, SBOM or quality gate; fail on skipped required checks |
| DEP-019 | `github/codeql-action/upload-sarif` | current | 12 | `tools/ci-security-quality` | Static analysis, image/dependency scanning, SBOM or quality gate; fail on skipped required checks |
| DEP-020 | `golangci/golangci-lint-action` | current | 01 | `tools/ci-foundation` | CI checkout, language setup or lint gate for reproducible builds |
| DEP-021 | `grafana/setup-k6-action` | current | 13 | `tools/ci-performance` | Load-test tool setup for measured capacity and SLO experiments |
| DEP-022 | `hashicorp/setup-terraform` | current | 12 | `tools/ci-delivery` | CI workflow action with least-privilege permissions and immutable verified pin |
| DEP-023 | `slackapi/slack-github-action` | current | 14 | `tools/ci-operations-notifications` | Explicitly configured deployment/chaos notifications; importing this plan does not send messages |
| DEP-024 | `SonarSource/sonarcloud-github-action` | historical | 12 | `tools/ci-security-quality` | Static analysis, image/dependency scanning, SBOM or quality gate; fail on skipped required checks |
| DEP-025 | `SonarSource/sonarqube-scan-action` | current | 12 | `tools/ci-security-quality` | Static analysis, image/dependency scanning, SBOM or quality gate; fail on skipped required checks |

### Go module

| ID | Catalog name | Category | Phase | Destination | Role |
| --- | --- | --- | --- | --- | --- |
| DEP-026 | `dario.cat/mergo` | current | 01 | `packages/config-go` | Configuration merge, properties or YAML parsing support resolved through owning modules |
| DEP-027 | `github.com/AdaLogics/go-fuzz-headers` | historical | 01 | `tests/go-services` | Go assertions, diffs, fixtures or fuzz-input support |
| DEP-028 | `github.com/aws/aws-sdk-go-v2` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-029 | `github.com/aws/aws-sdk-go-v2/config` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-030 | `github.com/aws/aws-sdk-go-v2/credentials` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-031 | `github.com/aws/aws-sdk-go-v2/feature/ec2/imds` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-032 | `github.com/aws/aws-sdk-go-v2/internal/configsources` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-033 | `github.com/aws/aws-sdk-go-v2/internal/endpoints/v2` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-034 | `github.com/aws/aws-sdk-go-v2/internal/ini` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-035 | `github.com/aws/aws-sdk-go-v2/service/dynamodb` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-036 | `github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-037 | `github.com/aws/aws-sdk-go-v2/service/internal/endpoint-discovery` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-038 | `github.com/aws/aws-sdk-go-v2/service/internal/presigned-url` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-039 | `github.com/aws/aws-sdk-go-v2/service/sso` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-040 | `github.com/aws/aws-sdk-go-v2/service/ssooidc` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-041 | `github.com/aws/aws-sdk-go-v2/service/sts` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-042 | `github.com/aws/smithy-go` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-043 | `github.com/Azure/go-ansiterm` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-044 | `github.com/beorn7/perks` | current | 11 | `packages/observability-go` | Prometheus client, model, metric helpers or process metrics dependency |
| DEP-045 | `github.com/bsm/redislock` | historical | 07 | `profiles/coordination-lab` | Historical Redis lease adapter; owner-token, expiry and fencing comparison |
| DEP-046 | `github.com/cenkalti/backoff/v4` | current | 07 | `packages/reliability-go` | Retry/backoff or atomic state helper; preserve version migration reference |
| DEP-047 | `github.com/cenkalti/backoff/v5` | current | 07 | `packages/reliability-go` | Retry/backoff or atomic state helper; preserve version migration reference |
| DEP-048 | `github.com/cespare/xxhash/v2` | current | 05 | `packages/redis-go` | Redis/cache routing and hashing dependency graph; also reused by saga coordination |
| DEP-049 | `github.com/containerd/errdefs` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-050 | `github.com/containerd/errdefs/pkg` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-051 | `github.com/containerd/log` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-052 | `github.com/containerd/platforms` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-053 | `github.com/cpuguy83/dockercfg` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-054 | `github.com/davecgh/go-spew` | current | 01 | `tests/go-services` | Go assertions, diffs, fixtures or fuzz-input support |
| DEP-055 | `github.com/dgryski/go-rendezvous` | current | 05 | `packages/redis-go` | Redis/cache routing and hashing dependency graph; also reused by saga coordination |
| DEP-056 | `github.com/distribution/reference` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-057 | `github.com/docker/docker` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-058 | `github.com/docker/go-connections` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-059 | `github.com/docker/go-units` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-060 | `github.com/ebitengine/purego` | current | 03 | `tests/go-integration` | Host/platform introspection dependency in the archived integration/runtime support graph |
| DEP-061 | `github.com/felixge/httpsnoop` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-062 | `github.com/go-logr/logr` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-063 | `github.com/go-logr/stdr` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-064 | `github.com/go-ole/go-ole` | current | 03 | `tests/go-integration` | Host/platform introspection dependency in the archived integration/runtime support graph |
| DEP-065 | `github.com/gocql/gocql` | current | 05 | `services/cassandra-writer` | Cassandra driver, host pooling or numeric representation dependency graph |
| DEP-066 | `github.com/gogo/protobuf` | historical | 02 | `packages/generated-rpc` | Protobuf/gRPC/generated API or gateway dependency; test generation and wire compatibility |
| DEP-067 | `github.com/golang-jwt/jwt/v4` | current | 09 | `packages/auth-go` | JWT/JWKS verification adapter; keep v4/v5 migration fixtures and one selected baseline |
| DEP-068 | `github.com/golang-jwt/jwt/v5` | historical | 09 | `packages/auth-go` | JWT/JWKS verification adapter; keep v4/v5 migration fixtures and one selected baseline |
| DEP-069 | `github.com/golang-migrate/migrate/v4` | current | 03 | `packages/postgres-go` | Postgres client/pool/configuration/migration support for owned state and outbox transactions |
| DEP-070 | `github.com/golang/snappy` | current | 04 | `packages/kafka-go` | Kafka client and compression-codec dependency graph |
| DEP-071 | `github.com/google/go-cmp` | current | 01 | `tests/go-services` | Go assertions, diffs, fixtures or fuzz-input support |
| DEP-072 | `github.com/google/uuid` | current | 02 | `packages/event-contracts-go` | Stable event/request identifiers and idempotency keys |
| DEP-073 | `github.com/gorilla/mux` | current | 02 | `packages/http-go` | Go HTTP route adapter and contract-bound handlers |
| DEP-074 | `github.com/grpc-ecosystem/grpc-gateway/v2` | current | 02 | `packages/generated-rpc` | Protobuf/gRPC/generated API or gateway dependency; test generation and wire compatibility |
| DEP-075 | `github.com/hailocab/go-hostpool` | current | 05 | `services/cassandra-writer` | Cassandra driver, host pooling or numeric representation dependency graph |
| DEP-076 | `github.com/hashicorp/errwrap` | historical | 01 | `packages/go-platform` | Error wrapping/aggregation support in current or historical Go dependency graphs |
| DEP-077 | `github.com/hashicorp/go-multierror` | historical | 01 | `packages/go-platform` | Error wrapping/aggregation support in current or historical Go dependency graphs |
| DEP-078 | `github.com/jackc/pgpassfile` | current | 03 | `packages/postgres-go` | Postgres client/pool/configuration/migration support for owned state and outbox transactions |
| DEP-079 | `github.com/jackc/pgservicefile` | current | 03 | `packages/postgres-go` | Postgres client/pool/configuration/migration support for owned state and outbox transactions |
| DEP-080 | `github.com/jackc/pgx/v5` | current | 03 | `packages/postgres-go` | Postgres client/pool/configuration/migration support for owned state and outbox transactions |
| DEP-081 | `github.com/jackc/puddle/v2` | current | 03 | `packages/postgres-go` | Postgres client/pool/configuration/migration support for owned state and outbox transactions |
| DEP-082 | `github.com/jmespath/go-jmespath` | current | 09 | `packages/aws-go` | Go AWS/DynamoDB adapter and its credential, endpoint, signing or protocol dependency graph |
| DEP-083 | `github.com/klauspost/compress` | current | 04 | `packages/kafka-go` | Kafka client and compression-codec dependency graph |
| DEP-084 | `github.com/lib/pq` | current | 03 | `packages/postgres-go` | Postgres client/pool/configuration/migration support for owned state and outbox transactions |
| DEP-085 | `github.com/lufia/plan9stats` | current | 03 | `tests/go-integration` | Host/platform introspection dependency in the archived integration/runtime support graph |
| DEP-086 | `github.com/magiconair/properties` | current | 01 | `packages/config-go` | Configuration merge, properties or YAML parsing support resolved through owning modules |
| DEP-087 | `github.com/mattn/go-colorable` | current | 11 | `packages/structured-logging-go` | Structured logging or terminal-formatting dependency; choose primary logger per service |
| DEP-088 | `github.com/mattn/go-isatty` | current | 11 | `packages/structured-logging-go` | Structured logging or terminal-formatting dependency; choose primary logger per service |
| DEP-089 | `github.com/MicahParks/keyfunc` | current | 09 | `packages/auth-go` | JWT/JWKS verification adapter; keep v4/v5 migration fixtures and one selected baseline |
| DEP-090 | `github.com/Microsoft/go-winio` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-091 | `github.com/moby/docker-image-spec` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-092 | `github.com/moby/go-archive` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-093 | `github.com/moby/patternmatcher` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-094 | `github.com/moby/sys/atomicwriter` | historical | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-095 | `github.com/moby/sys/sequential` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-096 | `github.com/moby/sys/user` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-097 | `github.com/moby/sys/userns` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-098 | `github.com/moby/term` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-099 | `github.com/morikuni/aec` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-100 | `github.com/opencontainers/go-digest` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-101 | `github.com/opencontainers/image-spec` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-102 | `github.com/pierrec/lz4/v4` | current | 04 | `packages/kafka-go` | Kafka client and compression-codec dependency graph |
| DEP-103 | `github.com/pkg/errors` | current | 01 | `packages/go-platform` | Error wrapping/aggregation support in current or historical Go dependency graphs |
| DEP-104 | `github.com/pmezard/go-difflib` | current | 01 | `tests/go-services` | Go assertions, diffs, fixtures or fuzz-input support |
| DEP-105 | `github.com/power-devops/perfstat` | current | 03 | `tests/go-integration` | Host/platform introspection dependency in the archived integration/runtime support graph |
| DEP-106 | `github.com/prometheus/client_golang` | current | 11 | `packages/observability-go` | Prometheus client, model, metric helpers or process metrics dependency |
| DEP-107 | `github.com/prometheus/client_model` | current | 11 | `packages/observability-go` | Prometheus client, model, metric helpers or process metrics dependency |
| DEP-108 | `github.com/prometheus/common` | current | 11 | `packages/observability-go` | Prometheus client, model, metric helpers or process metrics dependency |
| DEP-109 | `github.com/prometheus/procfs` | current | 11 | `packages/observability-go` | Prometheus client, model, metric helpers or process metrics dependency |
| DEP-110 | `github.com/redis/go-redis/v9` | current | 05 | `packages/redis-go` | Redis/cache routing and hashing dependency graph; also reused by saga coordination |
| DEP-111 | `github.com/rs/zerolog` | current | 11 | `packages/structured-logging-go` | Structured logging or terminal-formatting dependency; choose primary logger per service |
| DEP-112 | `github.com/segmentio/kafka-go` | current | 04 | `packages/kafka-go` | Kafka client and compression-codec dependency graph |
| DEP-113 | `github.com/shirou/gopsutil/v4` | current | 03 | `tests/go-integration` | Host/platform introspection dependency in the archived integration/runtime support graph |
| DEP-114 | `github.com/sirupsen/logrus` | current | 11 | `packages/structured-logging-go` | Structured logging or terminal-formatting dependency; choose primary logger per service |
| DEP-115 | `github.com/stretchr/testify` | current | 01 | `tests/go-services` | Go assertions, diffs, fixtures or fuzz-input support |
| DEP-116 | `github.com/testcontainers/testcontainers-go` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-117 | `github.com/testcontainers/testcontainers-go/modules/postgres` | current | 03 | `tests/go-integration` | Testcontainers/container-engine integration-test dependency graph; no separate production service |
| DEP-118 | `github.com/tklauser/go-sysconf` | current | 03 | `tests/go-integration` | Host/platform introspection dependency in the archived integration/runtime support graph |
| DEP-119 | `github.com/tklauser/numcpus` | current | 03 | `tests/go-integration` | Host/platform introspection dependency in the archived integration/runtime support graph |
| DEP-120 | `github.com/yusufpapurcu/wmi` | current | 03 | `tests/go-integration` | Host/platform introspection dependency in the archived integration/runtime support graph |
| DEP-121 | `go.opentelemetry.io/auto/sdk` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-122 | `go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-123 | `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-124 | `go.opentelemetry.io/otel` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-125 | `go.opentelemetry.io/otel/exporters/otlp/otlptrace` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-126 | `go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-127 | `go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp` | historical | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-128 | `go.opentelemetry.io/otel/exporters/stdout/stdouttrace` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-129 | `go.opentelemetry.io/otel/metric` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-130 | `go.opentelemetry.io/otel/sdk` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-131 | `go.opentelemetry.io/otel/sdk/trace` | historical | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-132 | `go.opentelemetry.io/otel/trace` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-133 | `go.opentelemetry.io/proto/otlp` | current | 11 | `packages/otel-go` | Go telemetry SDK, propagation, exporter or instrumentation support; retain graph-resolved dependencies |
| DEP-134 | `go.uber.org/atomic` | historical | 07 | `packages/reliability-go` | Retry/backoff or atomic state helper; preserve version migration reference |
| DEP-135 | `golang.org/x/crypto` | current | 01 | `packages/go-platform` | Go crypto/network/concurrency/system/text support; retain only dependencies resolved by selected direct consumers |
| DEP-136 | `golang.org/x/net` | current | 01 | `packages/go-platform` | Go crypto/network/concurrency/system/text support; retain only dependencies resolved by selected direct consumers |
| DEP-137 | `golang.org/x/sync` | current | 01 | `packages/go-platform` | Go crypto/network/concurrency/system/text support; retain only dependencies resolved by selected direct consumers |
| DEP-138 | `golang.org/x/sys` | current | 01 | `packages/go-platform` | Go crypto/network/concurrency/system/text support; retain only dependencies resolved by selected direct consumers |
| DEP-139 | `golang.org/x/text` | current | 01 | `packages/go-platform` | Go crypto/network/concurrency/system/text support; retain only dependencies resolved by selected direct consumers |
| DEP-140 | `google.golang.org/genproto/googleapis/api` | current | 02 | `packages/generated-rpc` | Protobuf/gRPC/generated API or gateway dependency; test generation and wire compatibility |
| DEP-141 | `google.golang.org/genproto/googleapis/rpc` | current | 02 | `packages/generated-rpc` | Protobuf/gRPC/generated API or gateway dependency; test generation and wire compatibility |
| DEP-142 | `google.golang.org/grpc` | current | 02 | `packages/generated-rpc` | Protobuf/gRPC/generated API or gateway dependency; test generation and wire compatibility |
| DEP-143 | `google.golang.org/protobuf` | current | 02 | `packages/generated-rpc` | Protobuf/gRPC/generated API or gateway dependency; test generation and wire compatibility |
| DEP-144 | `gopkg.in/inf.v0` | current | 05 | `services/cassandra-writer` | Cassandra driver, host pooling or numeric representation dependency graph |
| DEP-145 | `gopkg.in/yaml.v3` | current | 01 | `packages/config-go` | Configuration merge, properties or YAML parsing support resolved through owning modules |
| DEP-146 | `gotest.tools/v3` | historical | 01 | `tests/go-services` | Go assertions, diffs, fixtures or fuzz-input support |

### Python distribution

| ID | Catalog name | Category | Phase | Destination | Role |
| --- | --- | --- | --- | --- | --- |
| DEP-147 | `aiohttp` | current | 05 | `services/search-indexer` | Async search bulk HTTP transport |
| DEP-148 | `aiokafka` | current | 04 | `packages/kafka-python` | Async Kafka producer/consumer port used by risk and search |
| DEP-149 | `aws-cdk-lib` | current | 12 | `infra/cdk/serverless` | Separately owned AWS serverless stack definitions |
| DEP-150 | `boto3` | current | 10 | `services/integration-gateway` | AWS adapters for import/export and isolated FHIR/escalation Lambda fixtures |
| DEP-151 | `constructs` | current | 12 | `infra/cdk/serverless` | CDK construct composition; no overlapping Terraform resource ownership |
| DEP-152 | `elasticsearch` | current | 05 | `profiles/search-elastic` | Elasticsearch search-indexer adapter and compatibility tests |
| DEP-153 | `fastapi` | current | 06 | `packages/fastapi-platform` | Risk and integration HTTP service runtime |
| DEP-154 | `hatchling` | current | 01 | `tools/python-build` | Python package build backend |
| DEP-155 | `httpx` | current | 10 | `services/integration-gateway` | Bounded external HTTP integration client |
| DEP-156 | `kafka-python` | historical | 04 | `profiles/kafka-python-reference` | Historical synchronous Kafka adapter migration comparison |
| DEP-157 | `kafka-python-ng` | current | 04 | `profiles/kafka-python-sync` | Synchronous Kafka adapter profile behind the same canonical event contract |
| DEP-158 | `numpy` | current | 06 | `services/risk-engine` | Deterministic numerical feature extraction and scoring inputs |
| DEP-159 | `opensearch-py` | current | 05 | `profiles/search-opensearch` | OpenSearch indexer adapter and compatibility tests |
| DEP-160 | `opentelemetry-instrumentation-fastapi` | current | 11 | `packages/otel-python` | FastAPI request tracing instrumentation |
| DEP-161 | `opentelemetry-instrumentation-httpx` | current | 11 | `packages/otel-python` | Outbound integration HTTP tracing |
| DEP-162 | `opentelemetry-sdk` | current | 11 | `packages/otel-python` | Shared Python OpenTelemetry SDK and exporter bootstrap |
| DEP-163 | `pika` | historical | 07 | `profiles/python-rabbitmq-reference` | Historical Python work-queue adapter comparison with the Node worker contract |
| DEP-164 | `prometheus-fastapi-instrumentator` | current | 11 | `packages/observability-python` | FastAPI metrics instrumentation |
| DEP-165 | `psycopg2-binary` | current | 03 | `services/risk-engine` | Risk state/outbox Postgres transaction adapter; validate packaging for deployment |
| DEP-166 | `pydantic` | current | 02 | `packages/contracts-python` | Validated risk, integration and search payload/config contracts |
| DEP-167 | `pytest` | current | 01 | `tests/python-services` | Python unit/integration and Lambda fixture test runner |
| DEP-168 | `pytest-asyncio` | current | 01 | `tests/python-services` | Async service and consumer tests |
| DEP-169 | `python-dotenv` | current | 01 | `packages/config-python` | Local configuration loading without committed secret values |
| DEP-170 | `redis` | current | 06 | `services/risk-engine` | Redis risk cache/deduplication helper with durable correctness in Postgres |
| DEP-171 | `scikit-learn` | current | 06 | `services/risk-engine` | Versioned model experimentation, reproducible feature/model artifacts and evaluation |
| DEP-172 | `structlog` | current | 11 | `packages/structured-logging-python` | Structured correlated service logs |
| DEP-173 | `uvicorn` | current | 06 | `packages/fastapi-platform` | ASGI service process runtime and graceful lifecycle |

### Terraform module/provider

| ID | Catalog name | Category | Phase | Destination | Role |
| --- | --- | --- | --- | --- | --- |
| DEP-174 | `hashicorp/aws` | current | 12 | `infra/terraform/providers` | Terraform hashicorp/aws provider lock and state boundary for platform resources |
| DEP-175 | `hashicorp/helm` | current | 12 | `infra/terraform/providers` | Terraform hashicorp/helm provider lock and state boundary for platform resources |
| DEP-176 | `hashicorp/kubernetes` | current | 12 | `infra/terraform/providers` | Terraform hashicorp/kubernetes provider lock and state boundary for platform resources |
| DEP-177 | `hashicorp/tls` | current | 12 | `infra/terraform/providers` | Terraform hashicorp/tls provider lock and state boundary for platform resources |

### Terraform resource

| ID | Catalog name | Category | Phase | Destination | Role |
| --- | --- | --- | --- | --- | --- |
| DEP-178 | `aws_cloudwatch_log_group` | current | 12 | `infra/terraform/msk` | Managed Kafka configuration or broker log infrastructure and retention |
| DEP-179 | `aws_db_instance` | current | 12 | `infra/terraform/rds` | Owned relational database and private subnet configuration with backup/migration checks |
| DEP-180 | `aws_db_subnet_group` | current | 14 | `infra/terraform/disaster-recovery` | Cross-region data replication/failover resource; test restore, RPO/RTO and ownership |
| DEP-181 | `aws_dynamodb_table` | current | 09 | `infra/terraform/dynamodb` | Tenant-keyed AWS DynamoDB table with conditional writes, TTL and capacity controls |
| DEP-182 | `aws_ecr_lifecycle_policy` | current | 12 | `infra/terraform/ecr` | Container registry, access policy or image retention lifecycle |
| DEP-183 | `aws_ecr_repository` | current | 12 | `infra/terraform/ecr` | Container registry, access policy or image retention lifecycle |
| DEP-184 | `aws_ecr_repository_policy` | current | 12 | `infra/terraform/ecr` | Container registry, access policy or image retention lifecycle |
| DEP-185 | `aws_eip` | current | 12 | `infra/terraform/network` | Private network, routing, egress and service-specific security boundaries |
| DEP-186 | `aws_eks_cluster` | current | 12 | `infra/terraform/eks` | Kubernetes cluster/node infrastructure and controlled upgrade lifecycle |
| DEP-187 | `aws_eks_node_group` | current | 12 | `infra/terraform/eks` | Kubernetes cluster/node infrastructure and controlled upgrade lifecycle |
| DEP-188 | `aws_elasticache_global_replication_group` | current | 14 | `infra/terraform/disaster-recovery` | Cross-region data replication/failover resource; test restore, RPO/RTO and ownership |
| DEP-189 | `aws_elasticache_replication_group` | current | 12 | `infra/terraform/redis` | Managed Redis topology/private subnet configuration and replication controls |
| DEP-190 | `aws_elasticache_subnet_group` | current | 12 | `infra/terraform/redis` | Managed Redis topology/private subnet configuration and replication controls |
| DEP-191 | `aws_iam_openid_connect_provider` | current | 12 | `infra/terraform/identity` | OIDC/IRSA workload identity, minimal role/policy and trust boundaries |
| DEP-192 | `aws_iam_policy` | current | 12 | `infra/terraform/identity` | OIDC/IRSA workload identity, minimal role/policy and trust boundaries |
| DEP-193 | `aws_iam_role` | current | 12 | `infra/terraform/identity` | OIDC/IRSA workload identity, minimal role/policy and trust boundaries |
| DEP-194 | `aws_iam_role_policy_attachment` | current | 12 | `infra/terraform/identity` | OIDC/IRSA workload identity, minimal role/policy and trust boundaries |
| DEP-195 | `aws_internet_gateway` | current | 12 | `infra/terraform/network` | Private network, routing, egress and service-specific security boundaries |
| DEP-196 | `aws_msk_cluster` | current | 12 | `infra/terraform/msk` | Managed Kafka configuration or broker log infrastructure and retention |
| DEP-197 | `aws_msk_configuration` | current | 12 | `infra/terraform/msk` | Managed Kafka configuration or broker log infrastructure and retention |
| DEP-198 | `aws_nat_gateway` | current | 12 | `infra/terraform/network` | Private network, routing, egress and service-specific security boundaries |
| DEP-199 | `aws_rds_cluster` | current | 14 | `infra/terraform/disaster-recovery` | Cross-region data replication/failover resource; test restore, RPO/RTO and ownership |
| DEP-200 | `aws_rds_cluster_instance` | current | 14 | `infra/terraform/disaster-recovery` | Cross-region data replication/failover resource; test restore, RPO/RTO and ownership |
| DEP-201 | `aws_rds_global_cluster` | current | 14 | `infra/terraform/disaster-recovery` | Cross-region data replication/failover resource; test restore, RPO/RTO and ownership |
| DEP-202 | `aws_route_table` | current | 12 | `infra/terraform/network` | Private network, routing, egress and service-specific security boundaries |
| DEP-203 | `aws_route_table_association` | current | 12 | `infra/terraform/network` | Private network, routing, egress and service-specific security boundaries |
| DEP-204 | `aws_secretsmanager_secret` | current | 12 | `infra/terraform/secrets` | Secret metadata/version provisioning boundary; never copy archived secret values into plan or source |
| DEP-205 | `aws_secretsmanager_secret_version` | current | 12 | `infra/terraform/secrets` | Secret metadata/version provisioning boundary; never copy archived secret values into plan or source |
| DEP-206 | `aws_security_group` | current | 14 | `infra/terraform/disaster-recovery` | Cross-region data replication/failover resource; test restore, RPO/RTO and ownership |
| DEP-207 | `aws_subnet` | current | 12 | `infra/terraform/network` | Private network, routing, egress and service-specific security boundaries |
| DEP-208 | `aws_vpc` | current | 12 | `infra/terraform/network` | Private network, routing, egress and service-specific security boundaries |

### container image

| ID | Catalog name | Category | Phase | Destination | Role |
| --- | --- | --- | --- | --- | --- |
| DEP-209 | `alpine` | current | 01 | `tools/container-build` | Minimal service runtime base; architecture and libc compatibility checks |
| DEP-210 | `apache/kafka` | current | 04 | `profiles/events-apache` | Kafka KRaft broker profile for canonical domain events |
| DEP-211 | `bitnami/pgbouncer` | historical | 03 | `profiles/pgbouncer-reference` | Historical PgBouncer image comparison with transaction-local tenant/RLS tests |
| DEP-212 | `cassandra` | current | 05 | `profiles/timeseries` | Time-bucketed telemetry store, TTL, compaction and query-shaped tables |
| DEP-213 | `confluentinc/cp-kafka` | current | 04 | `profiles/events-confluent` | Alternate Kafka distribution profile, isolated from the Apache broker profile |
| DEP-214 | `confluentinc/cp-schema-registry` | current | 02 | `profiles/events` | Event schema compatibility registry; baseline depends on broker/client tests |
| DEP-215 | `curlimages/curl` | current | 01 | `tools/infra-probes` | Infrastructure readiness and smoke-test request runner |
| DEP-216 | `debezium/connect` | current | 04 | `profiles/cdc-reference` | Historical Debezium connector image comparison and migration fixtures |
| DEP-217 | `edoburu/pgbouncer` | current | 03 | `profiles/core` | Postgres connection pooling with transaction-mode/RLS acceptance tests |
| DEP-218 | `elasticsearch` | current | 05 | `profiles/search-elastic` | Elasticsearch read-store profile |
| DEP-219 | `ghcr.io/pahuldeepp/grainguard/bff` | current | 08 | `services/bff` | Archived published service image reference; rebuild from new GreenGuard source and verify provenance |
| DEP-220 | `ghcr.io/pahuldeepp/grainguard/cdc-transformer` | current | 04 | `services/cdc-transformer` | Archived published service image reference; rebuild from new GreenGuard source and verify provenance |
| DEP-221 | `ghcr.io/pahuldeepp/grainguard/dlq-reprocessor` | current | 14 | `services/dlq-reprocessor` | Archived published service image reference; rebuild from new GreenGuard source and verify provenance |
| DEP-222 | `ghcr.io/pahuldeepp/grainguard/gateway` | current | 08 | `services/gateway` | Archived published service image reference; rebuild from new GreenGuard source and verify provenance |
| DEP-223 | `ghcr.io/pahuldeepp/grainguard/read-model-builder` | current | 05 | `services/projection-builder` | Archived published service image reference; rebuild from new GreenGuard source and verify provenance |
| DEP-224 | `ghcr.io/pahuldeepp/grainguard/saga-orchestrator` | current | 07 | `services/saga-orchestrator` | Archived published service image reference; rebuild from new GreenGuard source and verify provenance |
| DEP-225 | `ghcr.io/pahuldeepp/grainguard/telemetry-service` | current | 03 | `services/telemetry-ingest` | Archived published service image reference; rebuild from new GreenGuard source and verify provenance |
| DEP-226 | `ghcr.io/shopify/toxiproxy` | current | 13 | `tests/chaos` | Deterministic network fault, delay and recovery experiments |
| DEP-227 | `golang` | current | 01 | `tools/go-build` | Go service builder image with verified toolchain/runtime compatibility |
| DEP-228 | `grafana/grafana` | current | 11 | `infra/observability/grafana` | Dashboards and operator views backed by observable service signals |
| DEP-229 | `grafana/loki` | current | 11 | `infra/observability/loki` | Structured log aggregation with retention and tenant-aware access |
| DEP-230 | `grafana/promtail` | historical | 11 | `profiles/log-collector-reference` | Historical log shipping profile; migration/reference coverage retained |
| DEP-231 | `grafana/tempo` | current | 11 | `infra/observability/tempo` | Distributed trace storage and search |
| DEP-232 | `kibana` | current | 05 | `profiles/search-elastic` | Elasticsearch diagnostics and search administration UI |
| DEP-233 | `memcached` | historical | 05 | `profiles/cache-lab` | Historical simple-cache adapter comparison behind the cache port |
| DEP-234 | `nginx` | historical | 08 | `profiles/dashboard-serving` | Historical static dashboard reverse-proxy/server option |
| DEP-235 | `node` | current | 01 | `tools/node-build` | Node service/dashboard build and runtime image |
| DEP-236 | `opensearchproject/opensearch` | current | 05 | `profiles/search-opensearch` | OpenSearch read-store profile with the same tested search port |
| DEP-237 | `otel/opentelemetry-collector` | historical | 11 | `profiles/otel-core-reference` | Historical core Collector profile and migration comparison |
| DEP-238 | `otel/opentelemetry-collector-contrib` | current | 11 | `infra/observability/otel-collector` | Shared telemetry receiving, processing and export |
| DEP-239 | `postgres` | current | 03 | `profiles/core` | Authoritative service databases, tenant RLS, transactional outbox/inbox |
| DEP-240 | `prom/blackbox-exporter` | current | 11 | `infra/observability/synthetic-probes` | External endpoint availability and user-flow probes |
| DEP-241 | `prom/prometheus` | current | 11 | `infra/observability/prometheus` | Service/infrastructure metrics, recording rules and alert evaluation |
| DEP-242 | `prometheuscommunity/postgres-exporter` | current | 11 | `infra/observability/postgres-exporter` | Database connection, saturation and availability metrics |
| DEP-243 | `provectuslabs/kafka-ui` | historical | 04 | `tools/kafka-administration` | Historical Kafka diagnostics/admin profile with restricted permissions |
| DEP-244 | `python` | current | 01 | `tools/python-build` | Python service base image and reproducible package build |
| DEP-245 | `quay.io/debezium/connect` | current | 04 | `profiles/events` | Debezium/Kafka Connect outbox CDC runtime |
| DEP-246 | `quay.io/keycloak/keycloak` | historical | 09 | `profiles/identity-lab` | Historical local OIDC provider comparison against Auth0 contracts |
| DEP-247 | `rabbitmq` | current | 07 | `profiles/workflows` | Work queues, explicit acknowledgement, retries and dead-letter routing |
| DEP-248 | `redis` | current | 05 | `profiles/core` | Cache/pub-sub/rate-limit substrate; cluster profile tests added at scale |

### npm

| ID | Catalog name | Category | Phase | Destination | Role |
| --- | --- | --- | --- | --- | --- |
| DEP-249 | `@anthropic-ai/claude-code` | current | 01 | `tools/developer-assistants` | Developer assistant or MCP tooling; configure separate optional developer profiles |
| DEP-250 | `@apollo/client` | current | 08 | `apps/dashboard` | Dashboard component, routing, authentication, GraphQL, visualization or virtualization dependency |
| DEP-251 | `@apollo/server` | current | 08 | `services/bff` | GraphQL composition, schema/resolver support, batching, query bounds or subscription transport |
| DEP-252 | `@auth0/auth0-react` | current | 08 | `apps/dashboard` | Dashboard component, routing, authentication, GraphQL, visualization or virtualization dependency |
| DEP-253 | `@aws-sdk/client-dynamodb` | current | 09 | `services/workflow-alerts` | Tenant-scoped alert mirror and escalation persistence in the AWS profile |
| DEP-254 | `@chromatic-com/storybook` | current | 08 | `tools/dashboard-storybook` | Component documentation, accessibility and visual/component-test workflow |
| DEP-255 | `@elastic/elasticsearch` | current | 08 | `services/bff` | Read-only backend adapter; retain store ownership and tenant-safe query boundaries |
| DEP-256 | `@eslint/js` | current | 01 | `tools/typescript-quality` | Shared linting, staged checks and developer hook configuration |
| DEP-257 | `@graphql-tools/schema` | current | 08 | `services/bff` | GraphQL composition, schema/resolver support, batching, query bounds or subscription transport |
| DEP-258 | `@graphql-tools/utils` | current | 08 | `services/bff` | GraphQL composition, schema/resolver support, batching, query bounds or subscription transport |
| DEP-259 | `@grpc/grpc-js` | current | 02 | `packages/generated-rpc` | Node gRPC client/server transport and versioned Protobuf contract loading |
| DEP-260 | `@grpc/proto-loader` | current | 02 | `packages/generated-rpc` | Node gRPC client/server transport and versioned Protobuf contract loading |
| DEP-261 | `@nestjs/cli` | current | 01 | `tools/nestjs` | NestJS service scaffolding and build tooling |
| DEP-262 | `@nestjs/common` | current | 03 | `packages/nest-platform` | Shared NestJS runtime baseline for device-service, workflow-alerts and billing-service |
| DEP-263 | `@nestjs/core` | current | 03 | `packages/nest-platform` | Shared NestJS runtime baseline for device-service, workflow-alerts and billing-service |
| DEP-264 | `@nestjs/microservices` | current | 07 | `services/workflow-alerts` | Kafka command/event handling and alert workflow service adapter |
| DEP-265 | `@nestjs/platform-express` | current | 03 | `packages/nest-platform` | Shared NestJS runtime baseline for device-service, workflow-alerts and billing-service |
| DEP-266 | `@nestjs/testing` | current | 01 | `tests/node-services` | Service test runtime, assertions, HTTP test harness and TypeScript test transforms |
| DEP-267 | `@openai/codex` | current | 01 | `tools/developer-assistants` | Developer assistant or MCP tooling; configure separate optional developer profiles |
| DEP-268 | `@opentelemetry/api` | current | 11 | `packages/otel-node` | Shared Node tracing SDK, instrumentation, resource and semantic-convention baseline |
| DEP-269 | `@opentelemetry/auto-instrumentations-node` | current | 11 | `packages/otel-node` | Shared Node tracing SDK, instrumentation, resource and semantic-convention baseline |
| DEP-270 | `@opentelemetry/exporter-trace-otlp-grpc` | current | 11 | `packages/otel-node` | Shared Node tracing SDK, instrumentation, resource and semantic-convention baseline |
| DEP-271 | `@opentelemetry/resources` | current | 11 | `packages/otel-node` | Shared Node tracing SDK, instrumentation, resource and semantic-convention baseline |
| DEP-272 | `@opentelemetry/sdk-node` | current | 11 | `packages/otel-node` | Shared Node tracing SDK, instrumentation, resource and semantic-convention baseline |
| DEP-273 | `@opentelemetry/sdk-trace-node` | current | 11 | `packages/otel-node` | Shared Node tracing SDK, instrumentation, resource and semantic-convention baseline |
| DEP-274 | `@opentelemetry/semantic-conventions` | current | 11 | `packages/otel-node` | Shared Node tracing SDK, instrumentation, resource and semantic-convention baseline |
| DEP-275 | `@playwright/test` | current | 08 | `tests/dashboard` | Browser, component, interaction and coverage test tooling |
| DEP-276 | `@prisma/client` | current | 03 | `services/device-service` | ORM client, migrations and atomic domain/outbox transactions; also owned separately by alerts and billing |
| DEP-277 | `@sendgrid/mail` | current | 07 | `services/notification-service` | Distinct sandbox-tested email provider adapters and delivery receipts |
| DEP-278 | `@storybook/addon-a11y` | current | 08 | `tools/dashboard-storybook` | Component documentation, accessibility and visual/component-test workflow |
| DEP-279 | `@storybook/addon-docs` | current | 08 | `tools/dashboard-storybook` | Component documentation, accessibility and visual/component-test workflow |
| DEP-280 | `@storybook/addon-onboarding` | current | 08 | `tools/dashboard-storybook` | Component documentation, accessibility and visual/component-test workflow |
| DEP-281 | `@storybook/addon-vitest` | current | 08 | `tools/dashboard-storybook` | Component documentation, accessibility and visual/component-test workflow |
| DEP-282 | `@storybook/react-vite` | current | 08 | `tools/dashboard-storybook` | Component documentation, accessibility and visual/component-test workflow |
| DEP-283 | `@testing-library/jest-dom` | current | 08 | `tests/dashboard` | Browser, component, interaction and coverage test tooling |
| DEP-284 | `@testing-library/react` | current | 08 | `tests/dashboard` | Browser, component, interaction and coverage test tooling |
| DEP-285 | `@testing-library/user-event` | current | 08 | `tests/dashboard` | Browser, component, interaction and coverage test tooling |
| DEP-286 | `@types/amqplib` | current | 07 | `services/jobs-worker` | TypeScript declarations for amqplib; align to its selected runtime/API major |
| DEP-287 | `@types/busboy` | current | 08 | `services/gateway` | TypeScript declarations for busboy; align to its selected runtime/API major |
| DEP-288 | `@types/cookie-parser` | current | 08 | `services/gateway` | TypeScript declarations for cookie-parser; align to its selected runtime/API major |
| DEP-289 | `@types/cors` | current | 08 | `services/gateway` | TypeScript declarations for cors; align to its selected runtime/API major |
| DEP-290 | `@types/express` | current | 08 | `services/gateway` | TypeScript declarations for express; align to its selected runtime/API major |
| DEP-291 | `@types/graphql-depth-limit` | current | 08 | `services/bff` | TypeScript declarations for graphql-depth-limit; align to its selected runtime/API major |
| DEP-292 | `@types/helmet` | historical | 08 | `services/gateway` | TypeScript declarations for helmet; align to its selected runtime/API major |
| DEP-293 | `@types/jest` | current | 01 | `tests/node-services` | Service test runtime, assertions, HTTP test harness and TypeScript test transforms |
| DEP-294 | `@types/node` | current | 01 | `tools/typescript-toolchain` | TypeScript compilation and local execution; align Node runtime and type versions |
| DEP-295 | `@types/pg` | current | 03 | `packages/postgres-node` | TypeScript declarations for pg; align to its selected runtime/API major |
| DEP-296 | `@types/react` | current | 08 | `apps/dashboard` | TypeScript declarations for react; align to its selected runtime/API major |
| DEP-297 | `@types/react-dom` | current | 08 | `apps/dashboard` | TypeScript declarations for react-dom; align to its selected runtime/API major |
| DEP-298 | `@types/react-window` | current | 08 | `apps/dashboard` | TypeScript declarations for react-window; align to its selected runtime/API major |
| DEP-299 | `@types/supertest` | current | 01 | `tests/node-services` | Service test runtime, assertions, HTTP test harness and TypeScript test transforms |
| DEP-300 | `@types/uuid` | current | 02 | `packages/event-contracts-node` | Historical UUID type declaration coverage; verify whether selected runtime already supplies types |
| DEP-301 | `@types/ws` | current | 08 | `services/bff` | TypeScript declarations for ws; align to its selected runtime/API major |
| DEP-302 | `@vitejs/plugin-react` | current | 08 | `tools/dashboard-build` | Dashboard bundling, CSS pipeline and React development checks |
| DEP-303 | `@vitest/browser-playwright` | current | 08 | `tests/dashboard` | Browser, component, interaction and coverage test tooling |
| DEP-304 | `@vitest/coverage-v8` | current | 08 | `tests/dashboard` | Browser, component, interaction and coverage test tooling |
| DEP-305 | `amqplib` | current | 07 | `services/jobs-worker` | RabbitMQ work queue consumption/publication, explicit acknowledgement, retries and DLQ |
| DEP-306 | `autoprefixer` | current | 08 | `tools/dashboard-build` | Dashboard bundling, CSS pipeline and React development checks |
| DEP-307 | `axios` | current | 07 | `services/jobs-worker` | Bounded external HTTP task/provider calls |
| DEP-308 | `busboy` | current | 08 | `services/gateway` | Edge HTTP transport, uploads, credential parsing, origin policy, security headers, limits and routing |
| DEP-309 | `cassandra-driver` | current | 08 | `services/bff` | Read-only backend adapter; retain store ownership and tenant-safe query boundaries |
| DEP-310 | `coderabbitai-mcp` | current | 01 | `tools/developer-assistants` | Developer assistant or MCP tooling; configure separate optional developer profiles |
| DEP-311 | `cookie-parser` | current | 08 | `services/gateway` | Edge HTTP transport, uploads, credential parsing, origin policy, security headers, limits and routing |
| DEP-312 | `cors` | current | 08 | `services/gateway` | Edge HTTP transport, uploads, credential parsing, origin policy, security headers, limits and routing |
| DEP-313 | `dataloader` | current | 08 | `services/bff` | GraphQL composition, schema/resolver support, batching, query bounds or subscription transport |
| DEP-314 | `dotenv` | current | 01 | `packages/config-node` | Validated local configuration loading; secrets remain outside committed files |
| DEP-315 | `eslint` | current | 01 | `tools/typescript-quality` | Shared linting, staged checks and developer hook configuration |
| DEP-316 | `eslint-plugin-react-hooks` | current | 08 | `tools/dashboard-build` | Dashboard bundling, CSS pipeline and React development checks |
| DEP-317 | `eslint-plugin-react-refresh` | current | 08 | `tools/dashboard-build` | Dashboard bundling, CSS pipeline and React development checks |
| DEP-318 | `eslint-plugin-storybook` | current | 08 | `tools/dashboard-storybook` | Component documentation, accessibility and visual/component-test workflow |
| DEP-319 | `express` | current | 08 | `services/gateway` | Edge HTTP transport, uploads, credential parsing, origin policy, security headers, limits and routing |
| DEP-320 | `express-rate-limit` | current | 08 | `services/gateway` | Edge HTTP transport, uploads, credential parsing, origin policy, security headers, limits and routing |
| DEP-321 | `globals` | current | 01 | `tools/typescript-quality` | Shared linting, staged checks and developer hook configuration |
| DEP-322 | `graphql` | current | 02 | `packages/graphql-contracts` | Shared GraphQL schema/protocol dependencies; test client/server interoperability |
| DEP-323 | `graphql-depth-limit` | current | 08 | `services/bff` | GraphQL composition, schema/resolver support, batching, query bounds or subscription transport |
| DEP-324 | `graphql-query-complexity` | current | 08 | `services/bff` | GraphQL composition, schema/resolver support, batching, query bounds or subscription transport |
| DEP-325 | `graphql-subscriptions` | current | 08 | `services/bff` | GraphQL composition, schema/resolver support, batching, query bounds or subscription transport |
| DEP-326 | `graphql-ws` | current | 02 | `packages/graphql-contracts` | Shared GraphQL schema/protocol dependencies; test client/server interoperability |
| DEP-327 | `helmet` | current | 08 | `services/gateway` | Edge HTTP transport, uploads, credential parsing, origin policy, security headers, limits and routing |
| DEP-328 | `http-proxy-middleware` | current | 08 | `services/gateway` | Edge HTTP transport, uploads, credential parsing, origin policy, security headers, limits and routing |
| DEP-329 | `husky` | current | 01 | `tools/typescript-quality` | Shared linting, staged checks and developer hook configuration |
| DEP-330 | `ioredis` | current | 05 | `packages/redis-node` | Redis client for tenant-bound cache, ephemeral pub/sub and guarded workflow coordination |
| DEP-331 | `jest` | current | 01 | `tests/node-services` | Service test runtime, assertions, HTTP test harness and TypeScript test transforms |
| DEP-332 | `jose` | current | 09 | `packages/auth-node` | OIDC/JWT/JWKS adapter coverage; choose one verified primary verifier and retain alternate adapter tests |
| DEP-333 | `jsdom` | current | 08 | `tests/dashboard` | Browser, component, interaction and coverage test tooling |
| DEP-334 | `jsonwebtoken` | current | 09 | `packages/auth-node` | OIDC/JWT/JWKS adapter coverage; choose one verified primary verifier and retain alternate adapter tests |
| DEP-335 | `jwks-rsa` | current | 09 | `packages/auth-node` | OIDC/JWT/JWKS adapter coverage; choose one verified primary verifier and retain alternate adapter tests |
| DEP-336 | `kafkajs` | current | 07 | `services/workflow-alerts` | Kafka command/event handling and alert workflow service adapter |
| DEP-337 | `lint-staged` | current | 01 | `tools/typescript-quality` | Shared linting, staged checks and developer hook configuration |
| DEP-338 | `pg` | current | 03 | `packages/postgres-node` | Explicit Postgres transactions for outbox/inbox, projections and audit ownership |
| DEP-339 | `playwright` | current | 08 | `tests/dashboard` | Browser, component, interaction and coverage test tooling |
| DEP-340 | `postcss` | current | 08 | `tools/dashboard-build` | Dashboard bundling, CSS pipeline and React development checks |
| DEP-341 | `prisma` | current | 03 | `services/device-service` | ORM client, migrations and atomic domain/outbox transactions; also owned separately by alerts and billing |
| DEP-342 | `prom-client` | current | 11 | `packages/observability-node` | Application metrics and bounded-cardinality Prometheus instrumentation |
| DEP-343 | `react` | current | 08 | `apps/dashboard` | Dashboard component, routing, authentication, GraphQL, visualization or virtualization dependency |
| DEP-344 | `react-dom` | current | 08 | `apps/dashboard` | Dashboard component, routing, authentication, GraphQL, visualization or virtualization dependency |
| DEP-345 | `react-hot-toast` | current | 08 | `apps/dashboard` | Dashboard component, routing, authentication, GraphQL, visualization or virtualization dependency |
| DEP-346 | `react-router-dom` | current | 08 | `apps/dashboard` | Dashboard component, routing, authentication, GraphQL, visualization or virtualization dependency |
| DEP-347 | `react-window` | current | 08 | `apps/dashboard` | Dashboard component, routing, authentication, GraphQL, visualization or virtualization dependency |
| DEP-348 | `recharts` | current | 08 | `apps/dashboard` | Dashboard component, routing, authentication, GraphQL, visualization or virtualization dependency |
| DEP-349 | `redis` | current | 08 | `services/bff` | Read-only backend adapter; retain store ownership and tenant-safe query boundaries |
| DEP-350 | `reflect-metadata` | current | 03 | `packages/nest-platform` | Shared NestJS runtime baseline for device-service, workflow-alerts and billing-service |
| DEP-351 | `resend` | current | 07 | `services/notification-service` | Distinct sandbox-tested email provider adapters and delivery receipts |
| DEP-352 | `rxjs` | current | 03 | `packages/nest-platform` | Shared NestJS runtime baseline for device-service, workflow-alerts and billing-service |
| DEP-353 | `storybook` | current | 08 | `tools/dashboard-storybook` | Component documentation, accessibility and visual/component-test workflow |
| DEP-354 | `stripe` | current | 09 | `services/billing-service` | Billing adapter, signature-verified webhook inbox, idempotency and entitlements |
| DEP-355 | `supertest` | current | 01 | `tests/node-services` | Service test runtime, assertions, HTTP test harness and TypeScript test transforms |
| DEP-356 | `tailwindcss` | current | 08 | `tools/dashboard-build` | Dashboard bundling, CSS pipeline and React development checks |
| DEP-357 | `ts-jest` | current | 01 | `tests/node-services` | Service test runtime, assertions, HTTP test harness and TypeScript test transforms |
| DEP-358 | `ts-node` | current | 01 | `tools/typescript-toolchain` | TypeScript compilation and local execution; align Node runtime and type versions |
| DEP-359 | `ts-node-dev` | current | 01 | `tools/typescript-toolchain` | TypeScript compilation and local execution; align Node runtime and type versions |
| DEP-360 | `typescript` | current | 01 | `tools/typescript-toolchain` | TypeScript compilation and local execution; align Node runtime and type versions |
| DEP-361 | `typescript-eslint` | current | 01 | `tools/typescript-quality` | Shared linting, staged checks and developer hook configuration |
| DEP-362 | `vite` | current | 08 | `tools/dashboard-build` | Dashboard bundling, CSS pipeline and React development checks |
| DEP-363 | `vitest` | current | 08 | `tests/dashboard` | Browser, component, interaction and coverage test tooling |
| DEP-364 | `winston` | current | 11 | `packages/structured-logging-node` | Structured service/audit logs and correlation; redact credentials and unnecessary payloads |
| DEP-365 | `ws` | current | 08 | `services/bff` | GraphQL composition, schema/resolver support, batching, query bounds or subscription transport |
| DEP-366 | `zod` | current | 02 | `packages/contracts-node` | HTTP/config/event payload validation at boundaries |

### runtime

| ID | Catalog name | Category | Phase | Destination | Role |
| --- | --- | --- | --- | --- | --- |
| DEP-367 | `Go` | current | 01 | `tools/go-toolchain` | Supported Go runtime/compiler baseline, lockfiles and CI version matrix |
| DEP-368 | `Python` | current | 01 | `tools/python-toolchain` | Supported Python runtime/compiler baseline, lockfiles and CI version matrix |

## Completion gate

Join this file with the catalog on `(kind, name)` and require exactly one disposition per catalog entry, a valid phase 01–14, nonempty destination and role, and an explicit current/historical category. An unclassified entry must remain visible and block its implementation milestone until triaged. The generated JSON currently passes those coverage checks.

Before a phase is complete, its owner must record a tested selected baseline and scenario evidence. Direct dependencies need relevant behavior tests; indirect dependencies need a resolved graph/lockfile and owning consumer; historical alternatives need an explicit migration or comparison record. A removed obsolete type package or duplicate version is covered by documented compatibility evidence, not by installing it unnecessarily.

## Required capability precedence

The coverage matrix defines mandatory executable profiles, including historical technology comparisons. A package-level historical note cannot waive a required capability. Obsolete versions and indirect/type dependencies may instead close with migration/compatibility evidence; unsupported versions do not enter the production critical path.
