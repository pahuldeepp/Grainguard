# CodeRabbit scoped review — 2026-09-28

- `infra/gitops/disposable/runtime-secret-lifecycle.py` and its regression
  tests: 0 findings.
- `services/tenant-control-plane/src/domain/placement.test.ts`: 0 findings.
- Notification migration compatibility and its regression test: first review
  found a test-resource cleanup issue. The test now tracks DB creation,
  closes clients before dropping the scratch DB, and always removes its temp
  directory. Follow-up review: 0 findings.

All reviews used `coderabbit review --uncommitted --agent` scoped to the
relevant directories. `git diff --check` passed.
