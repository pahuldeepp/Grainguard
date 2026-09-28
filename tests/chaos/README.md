# tests/chaos

Status: **planned**. A local-only manifest/ownership guard exists; workload
generation, fault execution, and Stage 13 certification are not implemented.

Stages: 07,13,14.

Technology: Toxiproxy, Chaos Toolkit.

Responsibility: Fault/recovery evidence including committed-event preservation.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.

The offline guard can be checked with:

```sh
node --test tests/chaos/stage13-harness.test.mjs
GREENGUARD_STAGE13_ENV=local node scripts/stage13-harness.mjs validate tests/chaos/workload.example.json
```

This validates bounded metadata only. It does not send requests, inject faults,
delete resources, or produce capacity/availability evidence. Missing or
non-local environment selection is rejected; future cleanup code must enforce
the run-scoped ownership contract before any provider operation.
