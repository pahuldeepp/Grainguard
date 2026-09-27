# Scoped EKS Pod Identity for the AWS Load Balancer Controller. This cell uses
# Terraform-owned ALB and target group; the controller only binds pod IPs to
# the mesh ingress target group. It cannot create load balancers or listeners.
data "aws_iam_policy_document" "alb_controller_pod_identity" {
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
      values   = ["aws-load-balancer-controller"]
    }
  }
}

resource "aws_iam_role" "alb_controller" {
  name               = "${local.edge_name}-alb-controller"
  assume_role_policy = data.aws_iam_policy_document.alb_controller_pod_identity.json
}

resource "aws_iam_role_policy" "alb_controller" {
  name = "${local.edge_name}-target-bindings"
  role = aws_iam_role.alb_controller.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DiscoverExistingTargetsAndVpc"
        Effect = "Allow"
        Action = [
          "ec2:DescribeAvailabilityZones",
          "ec2:DescribeInstances",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSubnets",
          "ec2:DescribeTags",
          "ec2:DescribeVpcs",
          "elasticloadbalancing:DescribeLoadBalancers",
          "elasticloadbalancing:DescribeTags",
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DescribeTargetHealth",
        ]
        Resource = "*"
      },
      {
        Sid    = "RegisterOnlyCellTargets"
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:RegisterTargets",
          "elasticloadbalancing:DeregisterTargets",
          "elasticloadbalancing:ModifyTargetGroup",
          "elasticloadbalancing:ModifyTargetGroupAttributes",
        ]
        Resource = aws_lb_target_group.mesh_ingress.arn
      },
    ]
  })
}

resource "aws_eks_pod_identity_association" "alb_controller" {
  cluster_name    = aws_eks_cluster.cell.name
  namespace       = "kube-system"
  service_account = "aws-load-balancer-controller"
  role_arn        = aws_iam_role.alb_controller.arn
  depends_on      = [aws_eks_addon.pod_identity_agent]
}

output "alb_controller_pod_identity_role_arn" {
  description = "Scoped Pod Identity role for binding the mesh ingress target group; controller/CRD installation is still required."
  value       = aws_iam_role.alb_controller.arn
}
