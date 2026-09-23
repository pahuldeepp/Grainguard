# Stage 01 local validation

Validated locally on 2026-09-21 (macOS ARM64) and closed on 2026-09-23 with a green Linux CI run. Stage 01 is complete. This is not a production or 10-million-customer capacity certification.

| Check | Result | Evidence |
|---|---|---|
| Bootstrap from lockfiles | Passed: generated ignored mode-0600 `.env`, npm ci, Go dependency download | [Setup](../docs/SETUP.md), lockfiles |
| Planning register and local repository links | Passed: 368 catalog entries and 141 coverage IDs | [Verification log](stage-01/verify.log) |
| Formatting, lint, TypeScript, HTTP/unit tests, Go vet/race, builds | Passed | [Verification log](stage-01/verify.log) |
| Required test failure is propagated | Passed: temporary failing dashboard test caused make verify to exit nonzero; test restored before successful verification | [Failure gate log](stage-01/failure-gate.log) |
| PostgreSQL startup and live service readiness | Passed after fixing database initialization to use SQL rather than a mounted shell script | [Smoke log](stage-01/smoke.log) |
| Database outage response | Passed: services with unreachable database return 503 while liveness stays healthy | [Smoke log](stage-01/smoke.log) |
| Database application privileges | Passed: neither role is superuser / role creator / database creator; cross-database connections denied | [Smoke log](stage-01/smoke.log) |
| Dashboard browser check | Passed: rendered foundation screen and both live Ready statuses observed | Local preview at http://127.0.0.1:5173 |
| Secret/build ignore rules | Passed: `.env`, node_modules, build and both dist directories ignored | `.gitignore` |
| Remote GitHub CI on a fresh Linux runner | Passed on `e675d22`: bootstrap, verify, audit, coverage, smoke, staging, SonarQube gate and image publication | [CI run 35890498228](https://github.com/pahuldeepp/Grainguard/actions/runs/35890498228) |
| SonarQube quality gate | Passed: 100% coverage (line and branch), 0% duplication, 0 issues, 0 security hotspots; it had correctly failed at 47.9% before the tests were added | [CI run](https://github.com/pahuldeepp/Grainguard/actions/runs/35890498228), [first failing run](https://github.com/pahuldeepp/Grainguard/actions/runs/35674452983) |
| Deliberately broken checks fail `make verify` | Passed: a failing Go test, a failing TypeScript test and a formatting violation each exit 2; the restored tree exits 0 | [Broken-check log](stage-01/broken-check-local.md) |
| Branch protection | Not available: GitHub returns HTTP 403 for a private repository without GitHub Pro. The workflow still blocks image publication when the gate fails. | [CI/CD setup](../docs/CI_CD.md) |

Runtime versions: Node 24.21.0, npm 11.19.0, Go 1.27.1, Docker 29.8.0, Compose 5.5.1. PostgreSQL image digest is pinned in [Compose](../infra/compose/compose.yaml). npm reported zero vulnerabilities during this install; this is a point-in-time dependency audit, not a complete security certification.

Only health/readiness endpoints and the foundation dashboard are implemented. Tenant isolation, domain persistence, authentication, outbox, CDC, BFF and the remaining technologies follow the [milestones](../docs/MILESTONES.md).
