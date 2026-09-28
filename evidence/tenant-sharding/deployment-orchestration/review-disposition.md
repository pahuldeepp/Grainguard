# Deployment runner review disposition

CodeRabbit completed the disposable GitOps scope with two findings: central
and shard migration host equality at chart rendering, and replication-slot
cleanup when retiring central operational connectors. Both findings were
forwarded to their owners; they are outside this runner's scope. The review
reported no findings in `check-deployed-workloads.py`, its tests, or the
orchestration document.

The optional Rollout CRD collection concern from the parent review was fixed:
the base workload query works without it; discovery collects installed
Rollouts separately. Missing contract deployments and Rollouts that require
controller-aware promotion remain blocked. Offline fixtures cover both paths.
The updated suite passes 17 tests with 94% runner statement coverage. Live
AWS/private-EKS/application and physical-iPhone evidence remains pending.

## Final adapter review

The final directory review completed with ten findings. The two runner findings
were fixed: the adapter now bounds the child process by readiness timeout plus
120 seconds, and the gate prints fixed malformed-JSON diagnostics without
contents or decoder details. Tests cover both, as well as rejection of
`prod`/`production` (case-insensitively) and malformed cell/release inputs
before AWS subprocesses, and mode `0600` on all temporary files.

The other eight findings concern connector replication-slot retirement,
namespace label limits, migration template/checker details, and runtime-secret
validation. They were forwarded to their owners for disposition; this runner
report does not claim those separate findings are resolved.

Current focused result: 24 tests passed (gate 18, adapter 6). Statement coverage
is 172/181 (95% combined; gate 94%, adapter 98%), passing the local 80% gate.
No AWS calls, plan/apply, or production changes were performed.
