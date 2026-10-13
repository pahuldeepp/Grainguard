locals {
  az_index                            = { for index, zone in var.availability_zones : zone => index }
  az_names                            = sort(var.availability_zones)
  cell_tags                           = { Project = "GreenGuard", Environment = var.environment, Cell = var.cluster_name }
  ecr_repository_prefix               = "greenguard/${var.environment}/cell-${substr(sha256(var.cluster_name), 0, 16)}"
  eventbridge_bridge_identity_enabled = var.eventbridge_event_bus_arn != "" && var.bridge_quarantine_queue_arn != ""
}

# The disposable Terraform root enables this scope-only anchor. Platform-only
# deployments leave its count at zero. All managed resources in this shared
# configuration depend on the address so disposable destroy can run the final
# inventory after the dependency graph has gone away.
resource "terraform_data" "destroy_inventory_sentinel" {
  count = var.enable_disposable_destroy_sentinel ? 1 : 0

  input = {
    region       = var.aws_region
    environment  = var.environment
    cluster_name = var.cluster_name
    account_id   = var.target_account_id
    script       = "${path.root}/post-destroy-inventory.sh"
    manifest     = "${path.root}/.last-destroy-pvs.scope.json"
    pv_inventory = "${path.root}/.last-destroy-pvs"
  }

  lifecycle {
    precondition {
      condition     = !contains(["prod", "production"], lower(var.environment))
      error_message = "The disposable root cannot manage a production environment."
    }
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["bash", "-c"]
    command     = "\"$GG_SCRIPT\" \"$GG_REGION\" \"$GG_ENVIRONMENT\" \"$GG_CLUSTER\" \"$GG_ACCOUNT\" \"$GG_MANIFEST\" \"$GG_PV_INVENTORY_FILE\""
    environment = {
      GG_SCRIPT            = self.input.script
      GG_REGION            = self.input.region
      GG_ENVIRONMENT       = self.input.environment
      GG_CLUSTER           = self.input.cluster_name
      GG_ACCOUNT           = self.input.account_id
      GG_MANIFEST          = self.input.manifest
      GG_PV_INVENTORY_FILE = self.input.pv_inventory
    }
  }
}

resource "aws_vpc" "cell" {
  depends_on           = [terraform_data.destroy_inventory_sentinel]
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.cell_tags, { Name = "${var.cluster_name}-vpc" })
}

resource "aws_internet_gateway" "cell" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  vpc_id     = aws_vpc.cell.id
  tags       = merge(local.cell_tags, { Name = "${var.cluster_name}-igw" })
}

resource "aws_subnet" "public" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each   = local.az_index

  vpc_id                  = aws_vpc.cell.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, each.value)
  map_public_ip_on_launch = true

  tags = {
    Name                     = "${var.cluster_name}-public-${each.key}"
    Project                  = local.cell_tags.Project
    Environment              = local.cell_tags.Environment
    Cell                     = local.cell_tags.Cell
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_subnet" "private" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each   = local.az_index

  vpc_id            = aws_vpc.cell.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, each.value + 8)

  tags = {
    Name                                        = "${var.cluster_name}-private-${each.key}"
    Project                                     = local.cell_tags.Project
    Environment                                 = local.cell_tags.Environment
    Cell                                        = local.cell_tags.Cell
    "kubernetes.io/role/internal-elb"           = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
    # Karpenter's EC2NodeClass selects node subnets by this tag.
    "karpenter.sh/discovery" = var.cluster_name
  }
}

resource "aws_route_table" "public" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  vpc_id     = aws_vpc.cell.id
  tags       = merge(local.cell_tags, { Name = "${var.cluster_name}-public" })
}

resource "aws_route" "public_internet" {
  depends_on             = [terraform_data.destroy_inventory_sentinel]
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.cell.id
}

resource "aws_route_table_association" "public" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each   = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each   = aws_subnet.public
  domain     = "vpc"
  tags       = merge(local.cell_tags, { Name = "${var.cluster_name}-nat-${each.key}" })
}

resource "aws_nat_gateway" "az" {
  for_each = aws_subnet.public

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = each.value.id

  depends_on = [aws_internet_gateway.cell,
    terraform_data.destroy_inventory_sentinel,
  ]
  tags = merge(local.cell_tags, { Name = "${var.cluster_name}-nat-${each.key}" })
}

resource "aws_route_table" "private" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each   = local.az_index
  vpc_id     = aws_vpc.cell.id
  tags       = merge(local.cell_tags, { Name = "${var.cluster_name}-private-${each.key}" })
}

resource "aws_route" "private_nat" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each   = local.az_index

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.az[each.key].id
}

resource "aws_route_table_association" "private" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each   = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

resource "aws_cloudwatch_log_group" "eks" {
  depends_on        = [terraform_data.destroy_inventory_sentinel]
  name              = "/aws/eks/${var.cluster_name}/cluster"
  retention_in_days = 90
}

resource "aws_cloudwatch_log_group" "vpc_flow" {
  depends_on        = [terraform_data.destroy_inventory_sentinel]
  name              = "/aws/vpc/${var.cluster_name}/flow"
  retention_in_days = 90
}

data "aws_iam_policy_document" "vpc_flow_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "vpc_flow" {
  depends_on         = [terraform_data.destroy_inventory_sentinel]
  name               = "${var.cluster_name}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.vpc_flow_assume_role.json
}

resource "aws_iam_role_policy" "vpc_flow" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  name       = "${var.cluster_name}-vpc-flow-logs"
  role       = aws_iam_role.vpc_flow.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"]
      Resource = "${aws_cloudwatch_log_group.vpc_flow.arn}:*"
    }]
  })
}

resource "aws_flow_log" "cell" {
  depends_on           = [terraform_data.destroy_inventory_sentinel]
  vpc_id               = aws_vpc.cell.id
  traffic_type         = "ALL"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.vpc_flow.arn
  iam_role_arn         = aws_iam_role.vpc_flow.arn
}

data "aws_iam_policy_document" "eks_cluster_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "eks_cluster" {
  depends_on         = [terraform_data.destroy_inventory_sentinel]
  name               = "${var.cluster_name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.eks_cluster_assume_role.json
}

resource "aws_iam_role_policy_attachment" "eks_cluster" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  role       = aws_iam_role.eks_cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

data "aws_iam_policy_document" "eks_node_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "eks_nodes" {
  depends_on         = [terraform_data.destroy_inventory_sentinel]
  name               = "${var.cluster_name}-nodes"
  assume_role_policy = data.aws_iam_policy_document.eks_node_assume_role.json
}

resource "aws_iam_role_policy_attachment" "eks_nodes" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPullOnly",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
  ])

  role       = aws_iam_role.eks_nodes.name
  policy_arn = each.value
}

resource "aws_kms_key" "eks_secrets" {
  depends_on              = [terraform_data.destroy_inventory_sentinel]
  description             = "EKS Kubernetes Secret envelope encryption for ${var.cluster_name}"
  deletion_window_in_days = var.kms_deletion_window_days
  enable_key_rotation     = true
}

resource "aws_eks_cluster" "cell" {
  name     = var.cluster_name
  role_arn = aws_iam_role.eks_cluster.arn
  version  = var.kubernetes_version

  lifecycle {
    precondition {
      condition     = (var.eventbridge_event_bus_arn == "") == (var.bridge_quarantine_queue_arn == "")
      error_message = "Set both eventbridge_event_bus_arn and bridge_quarantine_queue_arn, or leave both empty."
    }
  }

  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = false
  }

  vpc_config {
    subnet_ids              = [for zone in local.az_names : aws_subnet.private[zone].id]
    endpoint_private_access = true
    endpoint_public_access  = var.cluster_endpoint_public_access
    public_access_cidrs     = var.cluster_endpoint_public_access ? var.cluster_endpoint_public_access_cidrs : null
  }

  encryption_config {
    provider {
      key_arn = aws_kms_key.eks_secrets.arn
    }
    resources = ["secrets"]
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  depends_on = [
    aws_iam_role_policy_attachment.eks_cluster,
    aws_iam_role_policy.eks_secrets_encryption,
    aws_cloudwatch_log_group.eks,

    terraform_data.destroy_inventory_sentinel,
  ]
}

resource "aws_eks_access_entry" "cluster_admin" {
  depends_on    = [terraform_data.destroy_inventory_sentinel]
  cluster_name  = aws_eks_cluster.cell.name
  principal_arn = var.cluster_admin_role_arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "cluster_admin" {
  depends_on    = [terraform_data.destroy_inventory_sentinel]
  cluster_name  = aws_eks_cluster.cell.name
  principal_arn = aws_eks_access_entry.cluster_admin.principal_arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }
}

resource "aws_eks_addon" "core" {
  for_each = toset(["vpc-cni", "kube-proxy", "coredns"])

  cluster_name                = aws_eks_cluster.cell.name
  addon_name                  = each.value
  addon_version               = each.value == "vpc-cni" ? var.vpc_cni_addon_version : null
  configuration_values        = each.value == "vpc-cni" ? jsonencode({ enableNetworkPolicy = "true" }) : null
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_iam_role_policy_attachment.eks_nodes,
    terraform_data.destroy_inventory_sentinel,
  ]
}

resource "aws_eks_addon" "pod_identity_agent" {
  cluster_name                = aws_eks_cluster.cell.name
  addon_name                  = "eks-pod-identity-agent"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_iam_role_policy_attachment.eks_nodes,
    terraform_data.destroy_inventory_sentinel,
  ]
}

resource "aws_launch_template" "general" {
  depends_on  = [terraform_data.destroy_inventory_sentinel]
  name_prefix = "${var.cluster_name}-general-"

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 80
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  update_default_version = true
}

resource "aws_eks_node_group" "general" {
  cluster_name    = aws_eks_cluster.cell.name
  node_group_name = "${var.cluster_name}-general"
  node_role_arn   = aws_iam_role.eks_nodes.arn
  subnet_ids      = [for zone in local.az_names : aws_subnet.private[zone].id]
  instance_types  = var.general_instance_types
  capacity_type   = "ON_DEMAND"

  scaling_config {
    min_size     = var.general_node_min_size
    desired_size = var.general_node_desired_size
    max_size     = var.general_node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  launch_template {
    id      = aws_launch_template.general.id
    version = aws_launch_template.general.latest_version
  }

  labels = {
    "greenguard.io/workload-class" = "general"
  }

  depends_on = [aws_iam_role_policy_attachment.eks_nodes,
    terraform_data.destroy_inventory_sentinel,
  ]
}

resource "aws_launch_template" "compute" {
  depends_on  = [terraform_data.destroy_inventory_sentinel]
  name_prefix = "${var.cluster_name}-compute-"

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 100
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  update_default_version = true
}

resource "aws_eks_node_group" "compute" {
  cluster_name    = aws_eks_cluster.cell.name
  node_group_name = "${var.cluster_name}-compute"
  node_role_arn   = aws_iam_role.eks_nodes.arn
  subnet_ids      = [for zone in local.az_names : aws_subnet.private[zone].id]
  instance_types  = var.compute_instance_types
  capacity_type   = "ON_DEMAND"

  scaling_config {
    min_size     = 0
    desired_size = 0
    max_size     = var.compute_node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  launch_template {
    id      = aws_launch_template.compute.id
    version = aws_launch_template.compute.latest_version
  }

  labels = {
    "greenguard.io/workload-class" = "compute"
  }

  taint {
    key    = "greenguard.io/workload-class"
    value  = "compute"
    effect = "NO_SCHEDULE"
  }

  depends_on = [aws_iam_role_policy_attachment.eks_nodes,
    terraform_data.destroy_inventory_sentinel,
  ]
}

resource "aws_ecr_repository" "runtime" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each   = var.image_repositories

  name                 = "${local.ecr_repository_prefix}/${each.value}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.delete_nonempty_ecr_on_destroy

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}
