# Disposable Terraform lifecycle audit

Run `ruby infra/terraform/disposable/lifecycle-audit.rb --ready` from the repository root. The checker reads source files and makes no AWS calls. A nonzero exit means the one-command lifecycle remains unproved. `--json` prints machine-readable findings; `ruby infra/terraform/disposable/lifecycle-audit-test.rb` checks this audit's current baseline.

The owned foundation includes VPC, NAT/EIP, EKS and nodes, RDS, disposable Secrets Manager containers, ECR, Cognito, private ALB, CloudFront and WAF. CDK and Kubernetes-owned resources need separate cleanup before the network disappears. KMS deletion is scheduled with a seven-day AWS waiting period; the inventory must distinguish `PendingDeletion` from an active key.

Current blockers:

1. A failed apply before EKS exists can leave billable VPC/NAT/RDS resources. `destroy-verified.sh` currently rejects partial state without one exact EKS cluster and therefore cannot drive this recovery. Persist a cell scope before billable creation and derive the account and resource names from state, rather than trusting typed arguments.
2. Pre-destroy only verifies Kubernetes reachability and some delete permissions. It can mutate CloudFormation/Kubernetes resources before discovering missing permissions to list the final AWS inventory or to remove all provider-owned resources. Add a complete non-mutating preflight and retain a resumable scope.
3. Native `terraform destroy` has no guaranteed post-destroy hook. The verified wrapper runs `check-teardown.sh`, but the user's raw `terraform destroy` requirement cannot truthfully be called verified. Make the wrapper the documented operator entry point or use an external orchestrator for the final inventory. Preserve the fail-closed distinction.

Even after these source checks pass, live AWS destroy and final inventory are required. This checker does not claim that all billable resource classes can be found or that AWS eventual consistency has settled.
