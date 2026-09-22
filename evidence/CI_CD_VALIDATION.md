# CI/CD validation — 2026-09-21

- Private repository created and initial setup pushed: https://github.com/pahuldeepp/Grainguard.
- Initial Linux CI run: https://github.com/pahuldeepp/Grainguard/actions/runs/35674452983 completed: every functional check passed, SonarQube rejected 47.9% coverage against 100%, publication skipped, and artifacts/cleanup succeeded. [Full remote log](github-ci-35674452983.log), [remote gate report](github-sonar-quality-gate.json).
- Local `make verify`, coverage generation, dependency auditing and `make smoke` passed.
- Docker staging built all three app images and verified both live database readiness routes through nginx. [Transcript](staging-delivery.log).
- SonarQube Community Build 26.9.0.129388 and scanner 8.1.0.6389 executed a real analysis. [Transcript](sonar-initial-scan.log), [quality result](sonar-quality-gate.json).
- After addressing seven initial Sonar findings: 47.9% combined coverage, zero issues, zero duplication and zero security hotspots. The 100% coverage gate correctly returns failure. Image publication and verified release deployment are therefore blocked.
- Workflow syntax validated with actionlint 1.7.12. Action references and container base images are pinned to verified digests/commits.
- Application/container source changes passed local lint/type/test/build checks. Invalid deployment revisions are rejected before any deployment mutation. A successful remote-image release and rollback have not yet been exercised because the release gate has not passed.
- CodeRabbit CLI 0.7.8 installed with checksum verification, authenticated by the user, and review completed with one major finding, now addressed: QEMU required before multi-platform image builds. See [CodeRabbit review](CODERABBIT_REVIEW.md).
- GitHub private branch protection is unavailable on this account: API returned 403 requiring GitHub Pro or public visibility. Kept the repository private; no paid upgrade made.

The server, review tooling, CI and local staging are operational setup. They do not certify domain functionality, production readiness or 10-million-user capacity.
