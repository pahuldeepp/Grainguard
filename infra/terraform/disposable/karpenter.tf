# Karpenter supplies node capacity when KEDA/HPA-created pods cannot be
# scheduled (ADR-0031). Terraform owns the controller, its AWS prerequisites and
# the NodePools so their uninstall, and therefore instance termination, is in
# the destroy graph; pre-destroy.sh and check-teardown.sh cover the EC2
# instances and launch templates Karpenter creates outside this state.
variable "karpenter_compute_cpu_limit" {
  description = "Eventually consistent vCPU limit (NodePool limits.cpu) for Karpenter nodes in the tainted compute workload class; 0 renders no compute NodePool."
  type        = number
  default     = 0
  validation {
    condition     = var.karpenter_compute_cpu_limit == floor(var.karpenter_compute_cpu_limit) && (var.karpenter_compute_cpu_limit == 0 || (var.karpenter_compute_cpu_limit >= 2 && var.karpenter_compute_cpu_limit <= 32))
    error_message = "karpenter_compute_cpu_limit must be 0 (disabled) or a whole number of vCPUs between 2 and 32."
  }
}

variable "karpenter_general_cpu_limit" {
  description = "Eventually consistent vCPU limit (NodePool limits.cpu) for Karpenter nodes in the general workload class; 0 renders no general NodePool."
  type        = number
  default     = 0
  validation {
    condition     = var.karpenter_general_cpu_limit == floor(var.karpenter_general_cpu_limit) && (var.karpenter_general_cpu_limit == 0 || (var.karpenter_general_cpu_limit >= 2 && var.karpenter_general_cpu_limit <= 32))
    error_message = "karpenter_general_cpu_limit must be 0 (disabled) or a whole number of vCPUs between 2 and 32."
  }
}

variable "karpenter_node_ami_alias" {
  description = "Pinned EKS-optimized AL2023 AMI alias for Karpenter nodes, for example al2023@v20261001. Must be a release published for kubernetes_version; a floating @latest alias is rejected."
  type        = string
  default     = ""
  validation {
    condition     = (var.karpenter_compute_cpu_limit == 0 && var.karpenter_general_cpu_limit == 0 && var.karpenter_node_ami_alias == "") || can(regex("^al2023@v[0-9]{8}$", var.karpenter_node_ami_alias))
    error_message = "karpenter_node_ami_alias must be an explicit al2023@vYYYYMMDD release when provisioning is enabled, never al2023@latest."
  }
}

variable "karpenter_instance_families" {
  description = "x86_64 instance families Karpenter may launch. Sizes are fixed to 2 or 4 vCPUs by the NodePool chart."
  type        = list(string)
  default     = ["c7i", "m7i"]
  validation {
    condition     = length(var.karpenter_instance_families) > 0 && alltrue([for family in var.karpenter_instance_families : can(regex("^[cmr][a-z0-9]{1,6}i$", family))])
    error_message = "karpenter_instance_families must list standard-class Intel c/m/r families such as m7i or c7i; release images are built for linux/amd64 only."
  }
}

locals {
  # 30 + 1 + 8 + 3 characters; the longest suffix below keeps IAM role and
  # EventBridge rule names within their 64-character limits. check-teardown.sh
  # derives the same prefix.
  karpenter_name = "${substr(var.cluster_name, 0, 30)}-${substr(sha256(var.cluster_name), 0, 8)}-kp"
  # Configured limits, not a hard ceiling: parallel Karpenter provisioning
  # checks these eventually consistently. The preflight adds reserve capacity
  # without claiming to bound every possible overrun.
  karpenter_capacity_vcpus = var.karpenter_general_cpu_limit + var.karpenter_compute_cpu_limit
  karpenter_enabled_pools  = length([for limit in [var.karpenter_general_cpu_limit, var.karpenter_compute_cpu_limit] : limit if limit > 0])
  karpenter_interruption_events = {
    health      = { source = "aws.health", detail_type = "AWS Health Event" }
    spot        = { source = "aws.ec2", detail_type = "EC2 Spot Instance Interruption Warning" }
    rebalance   = { source = "aws.ec2", detail_type = "EC2 Instance Rebalance Recommendation" }
    state       = { source = "aws.ec2", detail_type = "EC2 Instance State-change Notification" }
    reservation = { source = "aws.ec2", detail_type = "EC2 Capacity Reservation Instance Interruption Warning" }
  }
  karpenter_owned_tag     = "kubernetes.io/cluster/${var.cluster_name}"
  karpenter_ec2_arn       = "arn:aws:ec2:${var.aws_region}"
  karpenter_cluster_match = { "aws:ResourceTag/${local.karpenter_owned_tag}" = "owned" }
  karpenter_request_match = {
    "aws:RequestTag/${local.karpenter_owned_tag}" = "owned"
    "aws:RequestTag/eks:eks-cluster-name"         = var.cluster_name
  }
}

data "aws_iam_policy_document" "karpenter_pod_identity" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/eks-cluster-arn"
      values   = [aws_eks_cluster.cell.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/kubernetes-namespace"
      values   = ["kube-system"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/kubernetes-service-account"
      values   = ["karpenter"]
    }
  }
}

resource "aws_iam_role" "karpenter_controller" {
  depends_on         = [terraform_data.destroy_inventory_sentinel]
  name               = "${local.karpenter_name}-controller"
  assume_role_policy = data.aws_iam_policy_document.karpenter_pod_identity.json
}

# Karpenter v1.15 controller policy, reduced for this cell: the instance
# profile is Terraform-owned, so the upstream instance-profile create, tag and
# delete statements are omitted, and zonal shift is not enabled. Every mutating
# EC2 action is conditioned on this cluster's ownership tags.
resource "aws_iam_role_policy" "karpenter_controller" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  name       = "${local.karpenter_name}-controller"
  role       = aws_iam_role.karpenter_controller.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowScopedEC2InstanceAccessActions"
        Effect = "Allow"
        Action = ["ec2:RunInstances", "ec2:CreateFleet"]
        Resource = [
          "${local.karpenter_ec2_arn}::image/*",
          "${local.karpenter_ec2_arn}::snapshot/*",
          "${local.karpenter_ec2_arn}:*:security-group/*",
          "${local.karpenter_ec2_arn}:*:subnet/*",
        ]
      },
      {
        Sid       = "AllowScopedEC2LaunchTemplateAccessActions"
        Effect    = "Allow"
        Action    = ["ec2:RunInstances", "ec2:CreateFleet"]
        Resource  = "${local.karpenter_ec2_arn}:*:launch-template/*"
        Condition = { StringEquals = local.karpenter_cluster_match, StringLike = { "aws:ResourceTag/karpenter.sh/nodepool" = "*" } }
      },
      {
        Sid    = "AllowScopedEC2InstanceActionsWithTags"
        Effect = "Allow"
        Action = ["ec2:RunInstances", "ec2:CreateFleet", "ec2:CreateLaunchTemplate"]
        Resource = [
          "${local.karpenter_ec2_arn}:*:fleet/*",
          "${local.karpenter_ec2_arn}:*:instance/*",
          "${local.karpenter_ec2_arn}:*:volume/*",
          "${local.karpenter_ec2_arn}:*:network-interface/*",
          "${local.karpenter_ec2_arn}:*:launch-template/*",
        ]
        Condition = { StringEquals = local.karpenter_request_match, StringLike = { "aws:RequestTag/karpenter.sh/nodepool" = "*" } }
      },
      {
        Sid    = "AllowScopedResourceCreationTagging"
        Effect = "Allow"
        Action = "ec2:CreateTags"
        Resource = [
          "${local.karpenter_ec2_arn}:*:fleet/*",
          "${local.karpenter_ec2_arn}:*:instance/*",
          "${local.karpenter_ec2_arn}:*:volume/*",
          "${local.karpenter_ec2_arn}:*:network-interface/*",
          "${local.karpenter_ec2_arn}:*:launch-template/*",
        ]
        Condition = {
          StringEquals = merge(local.karpenter_request_match, { "ec2:CreateAction" = ["RunInstances", "CreateFleet", "CreateLaunchTemplate"] })
          StringLike   = { "aws:RequestTag/karpenter.sh/nodepool" = "*" }
        }
      },
      {
        Sid      = "AllowScopedResourceTagging"
        Effect   = "Allow"
        Action   = "ec2:CreateTags"
        Resource = "${local.karpenter_ec2_arn}:*:instance/*"
        Condition = {
          StringEquals                = local.karpenter_cluster_match
          StringLike                  = { "aws:ResourceTag/karpenter.sh/nodepool" = "*" }
          StringEqualsIfExists        = { "aws:RequestTag/eks:eks-cluster-name" = var.cluster_name }
          "ForAllValues:StringEquals" = { "aws:TagKeys" = ["eks:eks-cluster-name", "karpenter.sh/nodeclaim", "Name"] }
        }
      },
      {
        Sid       = "AllowScopedDeletion"
        Effect    = "Allow"
        Action    = ["ec2:TerminateInstances", "ec2:DeleteLaunchTemplate"]
        Resource  = ["${local.karpenter_ec2_arn}:*:instance/*", "${local.karpenter_ec2_arn}:*:launch-template/*"]
        Condition = { StringEquals = local.karpenter_cluster_match, StringLike = { "aws:ResourceTag/karpenter.sh/nodepool" = "*" } }
      },
      {
        Sid    = "AllowRegionalReadActions"
        Effect = "Allow"
        Action = [
          "ec2:DescribeCapacityReservations",
          "ec2:DescribeImages",
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceStatus",
          "ec2:DescribeInstanceTypeOfferings",
          "ec2:DescribeInstanceTypes",
          "ec2:DescribeLaunchTemplates",
          "ec2:DescribePlacementGroups",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSpotPriceHistory",
          "ec2:DescribeSubnets",
        ]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.aws_region } }
      },
      {
        Sid      = "AllowSSMReadActions"
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = "arn:aws:ssm:${var.aws_region}::parameter/aws/service/*"
      },
      {
        Sid      = "AllowPricingReadActions"
        Effect   = "Allow"
        Action   = "pricing:GetProducts"
        Resource = "*"
      },
      {
        Sid      = "AllowUnscopedInstanceProfileListAction"
        Effect   = "Allow"
        Action   = "iam:ListInstanceProfiles"
        Resource = "*"
      },
      {
        Sid      = "AllowNodeInstanceProfileRead"
        Effect   = "Allow"
        Action   = "iam:GetInstanceProfile"
        Resource = aws_iam_instance_profile.karpenter_node.arn
      },
      {
        Sid       = "AllowPassingInstanceRole"
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = aws_iam_role.karpenter_node.arn
        Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } }
      },
      {
        Sid      = "AllowAPIServerEndpointDiscovery"
        Effect   = "Allow"
        Action   = "eks:DescribeCluster"
        Resource = aws_eks_cluster.cell.arn
      },
      {
        Sid      = "AllowInterruptionQueueActions"
        Effect   = "Allow"
        Action   = ["sqs:DeleteMessage", "sqs:GetQueueUrl", "sqs:ReceiveMessage"]
        Resource = aws_sqs_queue.karpenter_interruption.arn
      },
    ]
  })
}

resource "aws_eks_pod_identity_association" "karpenter" {
  cluster_name    = aws_eks_cluster.cell.name
  namespace       = "kube-system"
  service_account = "karpenter"
  role_arn        = aws_iam_role.karpenter_controller.arn
  depends_on = [aws_eks_addon.pod_identity_agent,
    terraform_data.destroy_inventory_sentinel,
  ]
}

# Karpenter nodes use their own role. EKS owns and removes the managed node
# groups' access entry, so sharing aws_iam_role.eks_nodes would let a node-group
# change revoke cluster access for running Karpenter nodes.
resource "aws_iam_role" "karpenter_node" {
  depends_on         = [terraform_data.destroy_inventory_sentinel]
  name               = "${local.karpenter_name}-node"
  assume_role_policy = data.aws_iam_policy_document.eks_node_assume_role.json
}

resource "aws_iam_role_policy_attachment" "karpenter_node" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPullOnly",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
  ])

  role       = aws_iam_role.karpenter_node.name
  policy_arn = each.value
}

# Terraform-owned so no IAM instance profile exists outside this state.
resource "aws_iam_instance_profile" "karpenter_node" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  name       = "${local.karpenter_name}-node"
  role       = aws_iam_role.karpenter_node.name
}

resource "aws_eks_access_entry" "karpenter_node" {
  depends_on    = [terraform_data.destroy_inventory_sentinel]
  cluster_name  = aws_eks_cluster.cell.name
  principal_arn = aws_iam_role.karpenter_node.arn
  type          = "EC2_LINUX"
}

resource "aws_sqs_queue" "karpenter_interruption" {
  depends_on                = [terraform_data.destroy_inventory_sentinel]
  name                      = local.karpenter_name
  message_retention_seconds = 300
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue_policy" "karpenter_interruption" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  queue_url  = aws_sqs_queue.karpenter_interruption.url

  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "EC2InterruptionPolicy"
    Statement = [
      {
        Sid       = "AllowCellInterruptionRules"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.karpenter_interruption.arn
        Condition = { ArnLike = { "aws:SourceArn" = "arn:aws:events:${var.aws_region}:${var.target_account_id}:rule/${local.karpenter_name}-*" } }
      },
      {
        Sid       = "DenyHTTP"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = aws_sqs_queue.karpenter_interruption.arn
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
}

resource "aws_cloudwatch_event_rule" "karpenter_interruption" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each   = local.karpenter_interruption_events

  name = "${local.karpenter_name}-${each.key}"
  event_pattern = jsonencode({
    source      = [each.value.source]
    detail-type = [each.value.detail_type]
  })
}

resource "aws_cloudwatch_event_target" "karpenter_interruption" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each   = local.karpenter_interruption_events

  rule      = aws_cloudwatch_event_rule.karpenter_interruption[each.key].name
  target_id = "KarpenterInterruptionQueueTarget"
  arn       = aws_sqs_queue.karpenter_interruption.arn
}

# Private subnets carry the same discovery tag in ../platform/main.tf. The
# cluster security group is created by EKS, so it is tagged here; it is the
# group the managed node groups already use.
resource "aws_ec2_tag" "karpenter_cluster_security_group" {
  depends_on  = [terraform_data.destroy_inventory_sentinel]
  resource_id = aws_eks_cluster.cell.vpc_config[0].cluster_security_group_id
  key         = "karpenter.sh/discovery"
  value       = var.cluster_name
}

# Kept outside the release block: check-controllers.rb rejects any
# `repository =` argument there because it would bypass the archive lock.
locals {
  karpenter_controller_values = {
    serviceAccount = { name = "karpenter" }
    replicas       = 2
    controller = {
      image = {
        repository = "public.ecr.aws/karpenter/controller"
        tag        = "1.15.0"
        digest     = "sha256:ab0f953e1460c61566d48209b517734ba79fe2105f335af1ff85faa8b6baf157"
      }
      resources = {
        requests = { cpu = "250m", memory = "512Mi" }
        limits   = { cpu = "1", memory = "512Mi" }
      }
    }
    # The chart keeps the controller off Karpenter-launched nodes; pin it to
    # the managed general pool so it never needs capacity it would create.
    nodeSelector = {
      "kubernetes.io/os"             = "linux"
      "greenguard.io/workload-class" = "general"
    }
    settings = {
      clusterName       = aws_eks_cluster.cell.name
      interruptionQueue = aws_sqs_queue.karpenter_interruption.name
    }
  }
}

resource "helm_release" "karpenter" {
  name      = "karpenter"
  namespace = "kube-system"
  chart     = "${path.module}/../../helm/controller-charts/karpenter-1.15.0.tgz"
  version   = "1.15.0"
  atomic    = true
  wait      = true
  timeout   = 900
  values    = [yamlencode(local.karpenter_controller_values)]
  depends_on = [
    aws_eks_node_group.general,
    aws_eks_access_policy_association.cluster_admin,
    aws_eks_pod_identity_association.karpenter,
    aws_iam_role_policy.karpenter_controller,
    aws_sqs_queue_policy.karpenter_interruption,
    terraform_data.eks_api_reachability,

    terraform_data.destroy_inventory_sentinel,
  ]
}

# EC2NodeClass and NodePools are Terraform-owned rather than Argo-delivered:
# they decide how much EC2 capacity may exist, take their role, AMI and limits
# from this root, and must be deleted (terminating their instances) before the
# controller, node role and network are destroyed.
resource "helm_release" "karpenter_nodepools" {
  name      = "greenguard-karpenter-nodepools"
  namespace = "kube-system"
  chart     = "${path.module}/../../gitops/disposable/karpenter-nodepools-chart"
  atomic    = true
  wait      = true
  timeout   = 1500
  values = [yamlencode({
    cell             = var.cluster_name
    environment      = var.environment
    instanceProfile  = aws_iam_instance_profile.karpenter_node.name
    amiAlias         = var.karpenter_node_ami_alias
    zones            = local.az_names
    instanceFamilies = var.karpenter_instance_families
    pools = {
      compute = { cpuLimit = var.karpenter_compute_cpu_limit }
      general = { cpuLimit = var.karpenter_general_cpu_limit }
    }
  })]
  depends_on = [
    helm_release.karpenter,
    aws_eks_access_entry.karpenter_node,
    aws_iam_role_policy_attachment.karpenter_node,
    aws_ec2_tag.karpenter_cluster_security_group,
    aws_cloudwatch_event_target.karpenter_interruption,
    aws_eks_addon.core,

    terraform_data.destroy_inventory_sentinel,
  ]
}

output "karpenter_capacity" {
  description = "Configured eventually consistent Karpenter NodePool limits; preflight also reserves capacity for replacement/parallel launches. Not a hard EC2 ceiling."
  value = {
    compute_cpu_limit = var.karpenter_compute_cpu_limit
    general_cpu_limit = var.karpenter_general_cpu_limit
    total_vcpus       = local.karpenter_capacity_vcpus
    enabled_pools     = local.karpenter_enabled_pools
    max_instance_vcpu = 4
  }
}
