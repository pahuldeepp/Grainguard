# Disposable Karpenter capacity

Terraform owns this chart and the pinned Karpenter 1.15.0 controller archive.
Both `karpenter_compute_cpu_limit` and `karpenter_general_cpu_limit` default to
zero: no EC2NodeClass or NodePool is rendered, so this configuration cannot
provision nodes until a pool receives an explicit budget. The controller still
runs with two replicas on the managed general nodes; KEDA remains available.

To enable a pool, configure a whole-number limit from 2 to 32 and supply a
published EKS AL2023 release alias (`al2023@vYYYYMMDD`) compatible with the
cluster version. The date shown in examples is illustrative, not proof of a
published AMI. The managed nodes, instance sizes, application requests and
replicas are unchanged. Only standard-class Intel c/m/r families and 2/4-vCPU
instances are eligible; release images are amd64. Compute nodes retain the
compute taint and workload-class label. General nodes retain the general label.

## Capacity guard

`capacity-preflight.tf` compares the approved regional EC2 standard vCPU quota
with the sum of managed node maxima, simultaneous managed update surge, every
enabled Karpenter limit, one 4-vCPU reserve per enabled pool, and
`capacity_extra_reserve_vcpus`. Add expected capacity of other cells and larger
parallel-launch reserves through that last input; it is not live usage discovery.

The existing defaults retain 32 vCPUs of managed maxima. With two AZs, concurrent
DEFAULT upgrades of general, compute and enabled parser groups reserve another
32 vCPUs, requiring 64 before any Karpenter pool is enabled. A compute limit of
4 adds 4 for the limit and 4 for its reserve, requiring 72. These are conservative
configured envelopes. The approved 8-vCPU quota cannot start the full current
application scope, whose requests already exceed 8 vCPUs before overhead.

[Karpenter limits are eventually consistent](https://karpenter.sh/docs/concepts/nodepools/#speclimits):
parallel scale-outs can exceed them. The reserve is a planning allowance, not a
hard bound on that overrun. Disruption budgets constrain voluntary disruption,
not parallel provisioning or forced replacement. AWS quota remains the regional
account limit, and enough approved quota does not prove free quota, AZ inventory,
or schedulable CPU/memory. Keep provisioning disabled until these live checks
pass. [EKS DEFAULT upgrades](https://docs.aws.amazon.com/eks/latest/userguide/managed-node-update-behavior.html)
can temporarily add two nodes per AZ per group; the guard sums those surges
conservatively for concurrent updates without changing upgrade availability.

## Identity and teardown

The controller uses EKS Pod Identity scoped to the cluster ARN, `kube-system`
and the `karpenter` service account. Its node role has its own EC2_LINUX access
entry and Terraform-owned instance profile. The controller cannot create or
delete IAM instance profiles. EC2 creation/deletion is scoped by cluster and
NodePool ownership tags, and PassRole names only the dedicated node role.
Interruption events target an encrypted cell-owned SQS queue that denies HTTP.
Node classes select discovered private subnets/security groups, require IMDSv2,
and use encrypted gp3 volumes removed on termination.

Pre-destroy stops the Argo workload owners and removes persistent workload
claims before deleting NodePools and NodeClaims while the controller, queue,
node role and network still exist. It then queries cluster-owned Karpenter EC2
instances directly, terminates survivors, waits for termination, and deletes
cluster-owned launch templates. Template queries use the pinned controller's
current `eks:eks-cluster-name` tag together with the exact
`kubernetes.io/cluster/<cell>=owned` tag and a `karpenter.sh/nodepool` marker;
all three filters must match. Neighboring templates, shared resources and
same-cluster templates without the Karpenter marker are excluded. Unreachable APIs, denied inventory, undeletable
NodePools or nonterminating instances stop destroy. The final inventory checks
instances, templates, interruption queues/rules and node instance profiles.

Offline coverage: `python3 infra/gitops/disposable/karpenter-nodepools-chart/test_chart.py`,
`python3 -m unittest infra/terraform/disposable/test_karpenter.py`,
`python3 -m unittest infra/terraform/disposable/test_capacity_preflight.py`,
and `ruby infra/terraform/disposable/lifecycle-audit-test.rb`.
Terraform mocks require locally initialized pinned AWS/Helm provider binaries.
Live acceptance still must prove Pod Identity credentials, AMI availability,
node registration/CNI, pending-Pod provisioning, interruption handling,
PVC/LB cleanup, and an empty AWS inventory after destroy.
