# Disposable Terraform lifecycle audit

Run `ruby infra/terraform/disposable/lifecycle-audit.rb --ready` from the repository root. The checker reads source files and makes no AWS calls. A nonzero exit means the one-command lifecycle remains unproved. `--json` prints machine-readable findings; `ruby infra/terraform/disposable/lifecycle-audit-test.rb` checks the source contracts, deliberate regressions, and the offline shell behavior fixtures.

The owned foundation includes VPC, NAT/EIP, EKS and nodes, RDS, disposable Secrets Manager containers, ECR, Cognito, private ALB, CloudFront and WAF. CDK and Kubernetes-owned resources need separate cleanup before the network disappears. KMS deletion is scheduled with a seven-day AWS waiting period; the inventory must distinguish `PendingDeletion` from an active key.

The verified wrapper now records a cell scope before VPC creation and can
recover a pre-EKS partial apply from state. It preflights inventory reads and
simulates its AWS delete permissions before cleanup. It also saves a
mode-0600 identity/managed-secret manifest before cleanup so an empty-state
retry can rerun final inventory; keep it and the PV inventory until inventory
passes.

Remaining limitations:

1. Terraform provider deletion permissions cannot be completely proven without attempting each delete. The wrapper checks inventory reads and simulates the out-of-state AWS deletes; an actual denial remains a resumable failure with local state intact.
2. Native `terraform destroy` has no guaranteed post-destroy hook. The
   `pre_destroy_cleanup` destroy provisioner requires an exact-scope marker
   supplied by `./destroy-verified.sh`, which inventories after Terraform
   exits. This is an operator guard, not a security boundary; a deliberate
   caller can set the marker manually. Raw `terraform destroy` cannot provide
   final inventory proof.

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

The expected current result is **one finding**: `raw_destroy_no_post_inventory`.
The scope marker makes accidental bare destroys stop, but does not add a
post-destroy provisioner or close the inventory limitation. Source checks and
stubbed fixtures establish the supported wrapper's contract, not a successful
live AWS teardown. IAM simulation does not establish provider delete authority
under every SCP or resource policy.

Recorded local evidence: [offline contract tests](../../../evidence/tenant-sharding/teardown-audit/offline-contract-tests.log) and [source findings](../../../evidence/tenant-sharding/teardown-audit/source-audit.json).
