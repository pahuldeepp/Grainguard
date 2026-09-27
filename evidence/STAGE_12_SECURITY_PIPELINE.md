# Stage 12.3 — security pipeline implementation record

Date: 2026-09-26

## Implemented gates

- CI runs a pinned Gitleaks v3 full-history scan with PR comments disabled.
- CI runs Trivy filesystem vulnerability and IaC misconfiguration scans with
  high/critical findings blocking the job; scanner errors also fail the job.
- CI separately scans an intentionally privileged/hostPath Kubernetes fixture,
  checks that Trivy produced a report with a high/critical failed
  misconfiguration, and requires Trivy's blocking exit status. The fixture is
  excluded from the ordinary repo scan so it does not intentionally fail every
  run.
- The main-branch image publish job covers the dashboard, BFF and all current
  service Dockerfiles: gateway, device-service, read-api, workflow-alerts,
  telemetry-ingest, cdc-transformer, projection-builder, cache-invalidator,
  risk-engine, hardware-service and eventbridge-bridge. It requests BuildKit
  SBOM and provenance attestations, scans each pushed digest for high/critical
  OS and library vulnerabilities, signs the exact digest with Cosign keyless
  OIDC, then verifies its signature against the expected GreenGuard
  main-branch workflow identity.
- Image publication depends on the secret and dependency/IaC scan jobs.
- Existing CI includes npm audit and SonarQube static analysis/quality checks.

Action references are pinned to immutable commit SHAs. The new image scan and
signing steps execute only in the existing main-push publication job; pull
requests have no registry write permission.

## Local verification

- `actionlint .github/workflows/ci.yml` — passed.
- `bash scripts/check-image-inventory.sh` — passed; all 13 published image
  Dockerfiles map to a CI service and Terraform ECR repository, with PgBouncer
  explicitly excluded from the application image matrix.
- `docker buildx build --check` — passed for every Dockerfile in the current
  publication matrix; this is a static BuildKit check, not an image build.
- `git diff --check` — passed.
- `make helm-validate` — passed for dashboard, BFF, ten HTTP runtime profiles
  and three worker profiles.
- Terraform format and validation — passed for the platform and bootstrap
  roots after adding matching ECR repositories for the image matrix.
- `bash -n scripts/check-trivy-fixture.sh` — passed. Trivy is not installed in
  this environment, so the expected-fail fixture itself has not run locally.

## Acceptance still open

The modified workflow has not run in GitHub Actions. Therefore secret scanner
behavior, real Trivy results, GHCR permissions, signature generation and
verification remain unproven. The fixture gate is implemented but has not run
locally because Trivy is not installed. No release digest or scanner report
from this working tree exists. The expanded matrix and eventbridge-bridge
Dockerfile pass static checks, but dependency installation and produced images
have not been built locally. Stage 12.3 is incomplete until these conditions
have actual CI evidence and any findings are triaged and fixed.
