# Grainguard CI/CD, SonarQube, and CodeRabbit

GitHub repository: https://github.com/pahuldeepp/Grainguard (private). The local project folder retains the GreenGuard name.

## Pipeline

Every pull request, main push, or manual CI run executes locked dependency installation, formatting/lint/type checks, tests and Go race/vet checks, builds, npm vulnerability auditing, coverage generation, database smoke tests, a live two-tenant read-role test, and a Docker staging check. Separate jobs exercise the event backbone, Cassandra history faults, and Kafka-to-Elasticsearch search. The quality job starts a fresh SonarQube instance, imports TypeScript, Go, and Python coverage, and waits for the quality gate. Missing reports, analysis failures and failed quality gates fail the job. Coverage and gate reports are retained for 14 days.

### No hosted-runner spend

The repository workflows use the `greenguard-ci` self-hosted Linux ARM64 runner
label so CI does not consume GitHub-hosted runner minutes. The current runner is
an Ubuntu 24.04 Lima VM with its own Docker daemon, no mounted host directories,
and no static AWS credentials. Short-lived AWS OIDC access is limited to the
protected promotion workflow. It is one runner, so jobs queue and execute serially;
GitHub checks remain queued while this VM is stopped or offline. Start it with
`limactl start greenguard-gha`, then run
`limactl shell greenguard-gha sudo -u runner bash -lc 'cd /home/runner/actions-runner && ./run.sh'`.
Stop the foreground runner with Ctrl-C and the VM with
`limactl stop greenguard-gha`. This avoids hosted-minute charges; GHCR package storage and
AWS resources are separately billed and are not made free by self-hosting.

GitHub returned HTTP 403 when querying branch protection: this account needs GitHub Pro (or a public repository) to protect this private branch. The repository remains private. Required merge checks cannot currently be enforced by GitHub branch protection; the workflow still blocks image publication on failed quality checks. No paid upgrade was performed.

Only a successful **main push** can publish dashboard, BFF and runtime service images to private GHCR packages. The image matrix includes gateway, device-service, read-api, workflow-alerts, telemetry-ingest, cdc-transformer, projection-builder, cache-invalidator, risk-engine, hardware-service and eventbridge-bridge. Image tags are the full commit SHA; BuildKit emits SBOM and provenance attestations. The publish job scans each pushed digest for unfixed high/critical OS and library vulnerabilities, signs that exact digest with Cosign keyless identity, and immediately verifies the signature against this workflow's main-branch identity. PR code has read-only GitHub permissions and no production/registry credentials. The separate CI secret-scan job scans history with Gitleaks; Trivy checks dependency manifests and IaC on every workflow run. SonarQube credentials in CI are generated for that disposable instance, never shared with the local server. Each CI run has an independent full-project analysis; the temporary server provides no persistent PR decoration or history. Download the reports from the Actions run; local SonarQube retains local history.

The `image-inventory` gate checks that every application/service Dockerfile is
mapped to exactly the expected published image service and to a Terraform ECR
repository. The PgBouncer infrastructure image is intentionally outside the
application image matrix. Local `docker buildx build --check` validates
Dockerfile syntax and source paths only; CI builds, scans, signs and verifies
actual images before publication.

The SonarQube scope includes the implemented dashboard, TypeScript services/packages, Go services, and Python search indexer. CI/deployment scripts are linted; workflow YAML is also validated locally with actionlint. SonarQube does not generate coverage: Vitest V8 and c8 generate LCOV, Go produces native profiles, and coverage.py generates Cobertura XML for Python. Source paths are normalized for the scanner's container workspace. Untested entry points remain included.

## Stage 08 live integration jobs

`redis-integration`, `oidc-integration`, `oidc-browser-integration`, and
`stage08-integration` run as separate jobs with read-only permissions,
pinned actions, and unconditional cleanup. They share the single serial
self-hosted runner. Like `events-integration`, they run
on each CI trigger and are dependencies of image publication. The full Stage
08 job builds the gateway, BFF, Read API, and workflow-alerts runtime images,
starts Kafka, MQTT, PostgreSQL, Cassandra, Elasticsearch, Redis Cluster, Dex,
and a local search-indexer environment, then runs `make browser-e2e`.
It uploads browser screenshots and the report even when the gate fails. The
live profiles remain opt-in locally and outside `make verify`. Browser jobs
install only Chromium from the lockfile's Playwright version.

Run locally after `make bootstrap` (Docker required):

```sh
make redis-up
make redis-test
make redis-down

# Shared prerequisites for either OIDC suite:
make db-up projection-migrate cassandra-up search-up
make oidc-up
make oidc-test
make oidc-down

# Browser suite, independently:
npx --no-install playwright install --with-deps chromium
make oidc-up
make oidc-browser-test
make oidc-down
make search-down cassandra-down db-down

# Full gateway/browser suite, independently after bootstrap:
make events-up
docker compose --env-file .env -f infra/compose/compose.yaml up -d --wait mosquitto
make cassandra-up search-up redis-up oidc-up
python3 -m venv .local/search-venv
.local/search-venv/bin/pip install -r services/search-indexer/requirements.txt
make browser-e2e
make oidc-down redis-down search-down cassandra-down events-down db-down
```

Run the corresponding cleanup commands even after a failing test. The Read API
now generates LCOV with c8 alongside the BFF; coverage normalization, SonarQube
source/test scope, and CI artifact checks/uploads include its report. Existing
shared test inclusion/exclusion globs apply to both services.

## Local SonarQube

```sh
make sonar-up
make sonar-init
make coverage
make sonar-scan
```

Open http://127.0.0.1:9000/dashboard?id=grainguard. Sign in as `admin`, using `SONAR_ADMIN_PASSWORD` from the ignored local `.env.sonar` file. Initialization replaces the default password, creates a private project, and stores a project analysis token locally. Do not commit or paste these values. Bootstrap is repeatable; deleting the credential file does not reset a persisted SonarQube database. `make sonar-down` stops the stack without deleting history.

This is local/ephemeral-CI SonarQube, bound to localhost with a separate PostgreSQL database and pinned images. Elasticsearch bootstrap host checks are disabled only for this local profile. A production SonarQube deployment would require proper host sizing, TLS, backups and operational configuration. The scanner image runs as linux/amd64, including through Docker emulation on Apple Silicon.

## Strict quality policy

The configured gate requires **at least 80% coverage (lowered from 100% by the owner on 2026-09-24), 0% duplication, and zero issues** across the analyzed foundation, plus the corresponding new-code requirements. Hotspots must be reviewed in SonarQube and the scan script separately requires zero hotspots, because SonarQube prohibits a raw hotspot-count quality-gate condition. Overall conditions ensure a fresh CI analysis cannot pass simply because it has no new-code baseline. The small-change coverage exemption is disabled.

The [first GitHub CI run](https://github.com/pahuldeepp/Grainguard/actions/runs/35674452983) completed all functional checks and artifact upload, then correctly blocked publication at the coverage gate.

At setup the gate reported 47.9% coverage and correctly failed. Tests were then added for every entry point, database adapter and dashboard lifecycle path (no source exclusions); the [CI run on e675d22](https://github.com/pahuldeepp/Grainguard/actions/runs/35890498228) passed the gate at **100% coverage, 0% duplication, 0 issues and 0 security hotspots** and published images with SBOM and provenance attestations. Generated Prisma client code (`**/generated/**`) and shared test fixtures (`**/testing/**`) are not product source and are excluded from analysis.

## Local staging and release deployment

```sh
make staging                         # Build and test the local working tree
make staging-down                    # Stop; keep database volume
make deploy REVISION=<40-character-successful-main-commit>
make rollback                        # Restore previous successful local release
```

Local staging is http://127.0.0.1:5174. Its database volume is independent from the development database; only the dashboard is exposed, on localhost. The dashboard proxies device and telemetry APIs and GraphQL through the gateway over the Compose network. The staging check verifies database-backed readiness and now also requires the proxied device and telemetry routes to reject anonymous requests with 401; a 404 means `AUTH_*` is missing and the product API was never mounted. The current staging Compose file omits service `AUTH_*` and membership configuration, so `make staging` intentionally fails this functional gate until those are supplied. Its gateway still uses placeholder identity/private upstream URLs; `stage08-integration` supplies separate gateway/browser proof. `make staging` does not claim a release passed SonarQube or prove the full event pipeline.

Release deployment requires a successful CI run including image publication for the specified main commit. Authenticate Docker to private GHCR using a minimally scoped credential with package read access (through password-stdin), and use the signed-in GitHub CLI to verify release status. No registry credential is embedded in the project. The deployment command runs locally; GitHub-hosted runners cannot deploy to your laptop. No self-hosted runner or public tunnel is installed.

After startup, both database-backed API routes and dashboard delivery are verified. A failed readiness check attempts to restore the previous successful release. Rollback does not undo database migrations; future migration stages must follow the documented forward/backward compatibility policy. No cloud deployment or production readiness is claimed.

## CodeRabbit CLI

The local review command uses `.local/tooling.json` for this workspace installation; fresh checkouts use CodeRabbit from PATH or `CODERABBIT_BIN`.

CodeRabbit CLI 0.7.8 was installed from the official distribution with its published checksum verified, and browser authentication was completed. Run from this project:

```sh
make review
# Or, after committing a feature:
coderabbit review --agent --base main --committed
```

The CLI reviews staged or tracked uncommitted changes; add new files to Git first. `.coderabbit.yaml` supplies review priorities for workflow security and backend correctness. Results are advisory and must be assessed and fixed; a successful CLI invocation does not mean there are no findings. The initial review completed with one major finding about missing ARM64 emulation; the workflow now includes pinned QEMU setup before Buildx. See [review evidence](../evidence/CODERABBIT_REVIEW.md).

CodeRabbit is an additional review step, not a replacement for deterministic checks or SonarQube.

This new repository is not yet connected to the CodeRabbit GitHub App. Authenticated local review uses the available free CLI allowance. GitHub PR auto-review requires installing the app for this repository; the configuration file alone does not grant it access. Usage-credit purchases are not enabled by these commands.

## Stage 12 Helm baseline

The dashboard and first BFF service chart are linted and rendered locally with
`make helm-validate`.
This verifies digest-only image input and key Pod/NetworkPolicy fields; it does
not prove a Kubernetes rollout, ingress/TLS setup, secret rotation, or canary
rollback. The validation uses an unmistakable all-zero digest solely to render
the manifests. It is not a real image and must not be installed.

The workflow supply-chain gates use pinned Gitleaks v3, Trivy v0.36.0 and
Cosign installer v4.1.2 actions. BuildKit already requests SBOM and provenance
generation. The private repository may not be eligible for GitHub artifact
attestations on its current account plan, so signatures use Cosign keyless
verification against GitHub Actions OIDC rather than assuming that service is
available. The IaC scanner also checks that a deliberately privileged fixture
produces a high/critical misconfiguration and a blocking exit code. A GitHub
Actions run is still required to prove registry signing, verification and
scanner behavior for published digests.

## References

- [SonarQube coverage reporting](https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/test-coverage/test-coverage-parameters)
- [SonarQube quality-gate CI integration](https://docs.sonarsource.com/sonarqube-community-build/analyzing-source-code/ci-integration/overview)
- [CodeRabbit CLI](https://docs.coderabbit.ai/cli)
