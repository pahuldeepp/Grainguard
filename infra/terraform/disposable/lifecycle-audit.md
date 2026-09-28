# Disposable Terraform lifecycle audit

Run `ruby infra/terraform/disposable/lifecycle-audit.rb --ready` from the repository root. The checker reads source files and makes no AWS calls. A nonzero exit means the one-command lifecycle remains unproved. `--json` prints machine-readable findings; `ruby infra/terraform/disposable/lifecycle-audit-test.rb` checks this audit's current baseline.

The owned foundation includes VPC, NAT/EIP, EKS and nodes, RDS, disposable Secrets Manager containers, ECR, Cognito, private ALB, CloudFront and WAF. CDK and Kubernetes-owned resources need separate cleanup before the network disappears. KMS deletion is scheduled with a seven-day AWS waiting period; the inventory must distinguish `PendingDeletion` from an active key.

The verified wrapper now records a cell scope before VPC creation and can
recover a pre-EKS partial apply from state. It preflights inventory reads and
simulates its AWS delete permissions before cleanup. Keep the state and the
saved PV inventory until post-destroy inventory passes.

Remaining limitations:

1. Terraform provider deletion permissions cannot be completely proven without attempting each delete. The wrapper checks inventory reads and simulates the out-of-state AWS deletes; an actual denial remains a resumable failure with local state intact.
2. Native `terraform destroy` has no guaranteed post-destroy hook. The documented operator entry point is `./destroy-verified.sh`, which runs the final inventory after Terraform exits. Raw `terraform destroy` cannot truthfully be called verified.

Even after these source checks pass, live AWS destroy and final inventory are required. This checker does not claim that all billable resource classes can be found or that AWS eventual consistency has settled.
