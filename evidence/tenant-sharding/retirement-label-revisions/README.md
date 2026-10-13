# Retirement, namespace label, and migration revision evidence

Focused offline validation completed on 2026-09-28. CodeRabbit uncommitted review of infra/gitops/disposable completed with **0 findings**; its exact output is in coderabbit-review.log.

- Python connector registration: 19 tests passed. Receipt opt-in validates trusted retirement receipt, tool/CA/credential prerequisites, exact connector and slot scope, and requires absence of both connectors and replication slots. Active slots cause bounded failure; no backend termination is used.
- Connector retirement Helm contract: 4 tests, 24 assertions passed.
- Kubernetes namespace label contract: 2 tests, 14 assertions passed.
- Migration behavior revision contracts: 2 tests, 56 assertions passed. Revision hashes cover runtime/SQL/gate images, host, secret/CA, network inputs, owner descriptor, and source revision; gate references match generated Jobs.
- Existing owner inventory, application tree and four-shard checks passed. Git diff whitespace check passed.
- Connector registration focused coverage: 175/206 statements, 85%, exceeding the requested 80% threshold for this Python scope. This is not a claim about external Sonar or repository-wide coverage.

Exact implementation and documentation files are listed in scope-files.txt. Public test output is stored beside this summary.

No AWS, live Connect, RDS, production, or shared database calls were made. Real Connect shutdown behavior, RDS role permission, replication slot/WAL cleanup, and private-cluster networking require live acceptance. The receipt consumes trusted fence/transfer assertions; it does not implement or independently prove the tenant mover. Receipt-enabled runtime images must supply Python 3 and psql. No-receipt registration receives no central retirement credentials or cleanup actions.
