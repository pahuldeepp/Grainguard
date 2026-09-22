# Grainguard CI/CD, SonarQube, and CodeRabbit

GitHub repository: https://github.com/pahuldeepp/Grainguard (private). The local project folder retains the GreenGuard name.

## Pipeline

Every pull request, main push, or manual CI run executes locked dependency installation, formatting/lint/type checks, tests and Go race/vet checks, builds, npm vulnerability auditing, coverage generation, database smoke tests, and a Docker staging check. It then starts a fresh isolated SonarQube instance, imports all three application components' coverage, and waits for the quality gate. Missing reports, analysis failures and failed quality gates fail the job. Coverage and gate reports are retained for 14 days.

GitHub returned HTTP 403 when querying branch protection: this account needs GitHub Pro (or a public repository) to protect this private branch. The repository remains private. Required merge checks cannot currently be enforced by GitHub branch protection; the workflow still blocks image publication on failed quality checks. No paid upgrade was performed.

Only a successful **main push** can publish dashboard, device-service and telemetry-ingest images to private GHCR packages. Image tags are the full commit SHA; local release deployment resolves them to immutable digests and stores those digests for rollback; builds include SBOM and provenance attestations. PR code has read-only GitHub permissions and no production/registry credentials. SonarQube credentials in CI are generated for that disposable instance, never shared with the local server. Each CI run has an independent full-project analysis; the temporary server provides no persistent PR decoration or history. Download the reports from the Actions run; local SonarQube retains local history.

The SonarQube scope is the three implemented application components. Future services join the source and coverage configuration when implemented. CI/deployment scripts are linted; workflow YAML is also validated locally with actionlint. SonarQube does not generate coverage: Vitest V8 generates dashboard LCOV, c8 maps compiled NestJS execution to TypeScript LCOV, and Go produces its native coverage profile. Source paths are normalized for the scanner's container workspace. Untested entry points remain included.

## Local SonarQube

```sh
make sonar-up
make sonar-init
make coverage
make sonar-scan
```

Open http://127.0.0.1:9000/dashboard?id=grainguard. Sign in as `admin`, using `SONAR_ADMIN_PASSWORD` from the ignored local `.env.sonar` file. Initialization replaces the default password, creates a private project, and stores a project analysis token locally. Do not commit or paste these values. Bootstrap is repeatable; deleting the credential file does not reset a persisted SonarQube database. `make sonar-down` stops the stack without deleting history.

This is local/ephemeral-CI SonarQube, bound to localhost with a separate PostgreSQL database and pinned images. Elasticsearch bootstrap host checks are disabled only for this local profile. A production SonarQube deployment would require proper host sizing, TLS, backups and operational configuration. The scanner image runs as linux/amd64, including through Docker emulation on Apple Silicon.

## Strict quality policy and current gap

The configured gate requires **100% coverage, 0% duplication, and zero issues** across the analyzed foundation, plus the corresponding new-code requirements. Hotspots must be reviewed in SonarQube and the scan script separately requires zero hotspots, because SonarQube prohibits a raw hotspot-count quality-gate condition. Overall conditions ensure a fresh CI analysis cannot pass simply because it has no new-code baseline. The small-change coverage exemption is disabled.

The [first GitHub CI run](https://github.com/pahuldeepp/Grainguard/actions/runs/35674452983) completed all functional checks and artifact upload, then correctly blocked publication at the coverage gate.

At setup validation, SonarQube reported **47.9% coverage, 0 issues, 0% duplication and 0 security hotspots** after fixing seven initial findings. Therefore **the quality gate correctly fails and image publication remains blocked**. Tests for dashboard lifecycle, database adapter paths, service startup and shutdown are the next work needed to reach the coverage target. No source files were excluded to manufacture a passing score.

## Local staging and release deployment

```sh
make staging                         # Build and test the local working tree
make staging-down                    # Stop; keep database volume
make deploy REVISION=<40-character-successful-main-commit>
make rollback                        # Restore previous successful local release
```

Local staging is http://127.0.0.1:5174. Its database volume is independent from the development database; only the dashboard is exposed, on localhost. The dashboard proxies both backend APIs over the Compose network. `make staging` is a development integration environment and does not claim a release passed SonarQube.

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

## References

- [SonarQube coverage reporting](https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/test-coverage/test-coverage-parameters)
- [SonarQube quality-gate CI integration](https://docs.sonarsource.com/sonarqube-community-build/analyzing-source-code/ci-integration/overview)
- [CodeRabbit CLI](https://docs.coderabbit.ai/cli)
