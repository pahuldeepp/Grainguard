# Stage 08 local SonarQube validation — 2026-09-25

The Stage 08 source set passed the local Grainguard strict SonarQube gate after the final dashboard, GraphQL BFF, gateway, and Read API changes. The scan reported **82.9% coverage**, **0.0% duplicated lines**, **0 violations**, and **0 security hotspots**. All quality-gate conditions were OK. The [machine-readable gate response](stage08-sonar/quality-gate.json) contains the condition values and metrics without credentials.

The scan used the repository's coverage reports, the 11 Stage 08 TypeScript configs, and a temporary scanner override excluding only the concurrent, unfinished Stage 09 paths `services/tenant-control-plane/**` and `packages/membership-client/**`. SCM attribution was disabled for this dirty local tree after an earlier scanner stalled while collecting blame; code, coverage, duplication, issue, and hotspot analysis remained enabled. The successful scanner finished at 17:04:26 local time with `QUALITY GATE STATUS: PASSED`.

The unscoped whole-repository gate is **not** passing yet: its preceding scan included Stage 09 work in progress and reported two Stage 09 source issues plus duplication between those new packages. Its two Stage 08 BFF issues were fixed before the passing scoped scan. Do not treat this Stage 08 result as a whole-repository or GitHub CI pass.
