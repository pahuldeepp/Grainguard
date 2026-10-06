# Disposable Terraform lifecycle audit

Run `ruby infra/terraform/disposable/lifecycle-audit.rb --ready` from the repository root. The checker reads source files and makes no AWS calls. A nonzero exit means the one-command lifecycle remains unproved. `--json` prints machine-readable findings; `ruby infra/terraform/disposable/lifecycle-audit-test.rb` checks the source contracts, deliberate regressions, and the offline shell behavior fixtures.

The owned foundation includes VPC, NAT/EIP, EKS and nodes, RDS, disposable Secrets Manager containers, ECR, Cognito, private ALB, CloudFront and WAF. CDK and Kubernetes-owned resources need separate cleanup before the network disappears. KMS deletion is scheduled with a seven-day AWS waiting period; the inventory must distinguish `PendingDeletion` from an active key.

The verified wrapper records a cell scope before VPC creation and can recover
a pre-EKS partial apply from state. It preflights inventory reads and simulates
its AWS delete permissions before cleanup. It saves a mode-0600
identity/managed-secret manifest before cleanup so an empty-state retry can
rerun final inventory; keep it and the PV inventory until inventory passes.
For a complete apply, the root also wires every managed resource to a
scope-only `terraform_data.destroy_inventory_sentinel`. Terraform reverses
these edges during destroy: pre-destroy cleanup runs first and the sentinel's
final AWS inventory runs after all managed resources.

Remaining limitations:

1. Terraform provider deletion permissions cannot be completely proven without attempting each delete. The wrapper checks inventory reads and simulates the out-of-state AWS deletes; an actual denial remains a resumable failure with local state intact.
2. A partial apply may not have recorded `pre_destroy_cleanup`. Use
   `./destroy-verified.sh` for partial-state recovery because it performs
   cleanup while EKS and its PV inventory are still available. Raw Terraform
   destroy is proven only for a complete apply with the cleanup owner present;
   a raw destroy of partial state is not established safe.

Even after these source checks pass, live AWS destroy and final inventory are required. This checker does not claim that all billable resource classes can be found or that AWS eventual consistency has settled.

## Corrected offline proof

The audit checks executable scope recovery and ordering rather than names of
unimplemented helper functions. It requires the VPC reference to the saved
`cell_scope`, missing-output recovery from Terraform state, refusal to recover
from an invalid existing identity, account/production guards, inventory read
preflight and delete simulation before cleanup, and cleanup → Terraform destroy
→ final inventory under `set -euo pipefail`. Full-line comments cannot satisfy
these contracts. Mutation fixtures remove or reorder these operations and must
produce findings. The audit also executes `teardown_test.sh`, whose stubbed
AWS/Kubernetes/Terraform fixtures cover pre-EKS partial state, wrong account,
unreachable EKS, denied reads/deletes, preserved PV inventory, failed destroy,
and leftover resources after destroy. These commands make no AWS calls.

The current offline source audit checks every resource edge to the sentinel,
every resource edge in the pre-cleanup dependency set, scope-only sentinel
inputs, and the absence of `create_before_destroy` ordering suppression.
Stubbed fixtures exercise missing/invalid manifests, dirty inventory failure,
and retry after cleanup. These checks prove configuration contracts, not live
AWS behavior. IAM simulation does not establish provider delete authority
under every SCP or resource policy; live AWS destroy and final inventory are
still required.

Recorded local evidence: [offline contract tests](../../../evidence/tenant-sharding/teardown-audit/offline-contract-tests.log) and [source findings](../../../evidence/tenant-sharding/teardown-audit/source-audit.json).
