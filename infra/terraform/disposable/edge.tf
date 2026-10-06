# A domainless disposable cell uses CloudFront's AWS-owned HTTPS names. The
# origin ALB is private; no ACM certificate or Route 53 zone is required.
# Both distributions share one ALB and one Istio ingress target group. A
# CloudFront-only origin header selects the BFF or dashboard VirtualService.
locals {
  # Truncation plus a digest keeps ALB names legal and distinct for any valid
  # EKS cluster_name, including uppercase names, underscores and long names.
  edge_name = "${substr(lower(replace(var.cluster_name, "_", "-")), 0, 17)}-${substr(sha1(var.cluster_name), 0, 8)}"
  # Keep the first disposable cell in regions the operator named and AWS
  # currently documents for CloudFront VPC origins. Regional expansion should
  # be a deliberate compatibility review, not an optimistic apply.
  edge_supported_regions = ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "ca-west-1"]
  edge_excluded_zone_ids = ["use1-az3", "usw1-az2", "cac1-az3"]
}

data "aws_availability_zone" "edge" {
  for_each = local.az_index
  name     = each.key
}

data "aws_ec2_managed_prefix_list" "cloudfront_origin" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "edge" {
  depends_on  = [terraform_data.destroy_inventory_sentinel]
  name_prefix = "${local.edge_name}-"
  description = "Private GreenGuard CloudFront VPC origin ALB"
  vpc_id      = aws_vpc.cell.id
  tags        = { Name = "${var.cluster_name}-edge" }
}

resource "aws_vpc_security_group_ingress_rule" "cloudfront_to_edge" {
  depends_on        = [terraform_data.destroy_inventory_sentinel]
  security_group_id = aws_security_group.edge.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin.id
  ip_protocol       = "tcp"
  from_port         = 8080
  to_port           = 8080
  description       = "CloudFront origin-facing networks to private ALB"
}

resource "aws_vpc_security_group_egress_rule" "edge_to_ingress_pods" {
  depends_on        = [terraform_data.destroy_inventory_sentinel]
  security_group_id = aws_security_group.edge.id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 8080
  to_port           = 8080
  description       = "ALB to Istio ingress pod IP targets"
}

resource "aws_vpc_security_group_egress_rule" "edge_to_ingress_health" {
  depends_on        = [terraform_data.destroy_inventory_sentinel]
  security_group_id = aws_security_group.edge.id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 15021
  to_port           = 15021
  description       = "ALB health checks to Istio ingress readiness port"
}

resource "aws_vpc_security_group_ingress_rule" "edge_to_ingress_eks_nodes" {
  depends_on                   = [terraform_data.destroy_inventory_sentinel]
  security_group_id            = aws_eks_cluster.cell.vpc_config[0].cluster_security_group_id
  referenced_security_group_id = aws_security_group.edge.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  description                  = "Private ALB to Istio ingress pod IPs"
}

resource "aws_vpc_security_group_ingress_rule" "edge_to_ingress_health_eks_nodes" {
  depends_on                   = [terraform_data.destroy_inventory_sentinel]
  security_group_id            = aws_eks_cluster.cell.vpc_config[0].cluster_security_group_id
  referenced_security_group_id = aws_security_group.edge.id
  ip_protocol                  = "tcp"
  from_port                    = 15021
  to_port                      = 15021
  description                  = "Private ALB health checks to Istio ingress readiness port"
}

resource "aws_lb" "edge" {
  depends_on                 = [terraform_data.destroy_inventory_sentinel]
  name                       = "${local.edge_name}-edge"
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.edge.id]
  subnets                    = [for zone in local.az_names : aws_subnet.private[zone].id]
  enable_deletion_protection = false
  idle_timeout               = 120
  tags                       = { Name = "${var.cluster_name}-edge" }
}

resource "aws_lb_target_group" "mesh_ingress" {
  depends_on  = [terraform_data.destroy_inventory_sentinel]
  name_prefix = "ggmsh-"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.cell.id
  tags        = { Cell = var.cluster_name }

  health_check {
    path                = "/healthz/ready"
    port                = "15021"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "edge" {
  depends_on        = [terraform_data.destroy_inventory_sentinel]
  load_balancer_arn = aws_lb.edge.arn
  port              = 8080
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.mesh_ingress.arn
  }
}

resource "aws_cloudfront_vpc_origin" "edge" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  tags       = { Cell = var.cluster_name }
  lifecycle {
    precondition {
      condition     = contains(local.edge_supported_regions, var.aws_region)
      error_message = "CloudFront VPC origin for this disposable cell is restricted to reviewed US/Canada regions."
    }
    precondition {
      condition     = alltrue([for zone in data.aws_availability_zone.edge : !contains(local.edge_excluded_zone_ids, zone.zone_id)])
      error_message = "An AZ selected for the CloudFront VPC origin is excluded by AWS; choose different availability_zones."
    }
  }

  vpc_origin_endpoint_config {
    name                   = "${local.edge_name}-edge"
    arn                    = aws_lb.edge.arn
    http_port              = 8080
    https_port             = 443
    origin_protocol_policy = "http-only"
    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# One WAF ACL protects both AWS-owned distribution hostnames. CloudFront WAF
# must be managed in us-east-1 even when EKS is in a different region.
resource "aws_wafv2_web_acl" "edge" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  provider   = aws.global
  name       = "${local.edge_name}-edge"
  scope      = "CLOUDFRONT"
  tags       = { Cell = var.cluster_name }

  default_action {
    allow {}
  }

  rule {
    name     = "aws-common-rules"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.cluster_name}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "ip-rate-limit"
    priority = 2
    action {
      block {}
    }
    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 2000
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.cluster_name}-rate"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.cluster_name}-edge"
    sampled_requests_enabled   = true
  }
}

resource "aws_cloudfront_cache_policy" "static_assets" {
  depends_on  = [terraform_data.destroy_inventory_sentinel]
  name        = "${var.cluster_name}-static-assets"
  min_ttl     = 0
  default_ttl = 86400
  max_ttl     = 31536000
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}

resource "aws_cloudfront_distribution" "web" {
  depends_on          = [terraform_data.destroy_inventory_sentinel]
  enabled             = true
  comment             = "${var.cluster_name} dashboard"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  web_acl_id          = aws_wafv2_web_acl.edge.arn
  is_ipv6_enabled     = true
  wait_for_deployment = true
  tags                = { Cell = var.cluster_name }

  origin {
    domain_name = aws_lb.edge.dns_name
    origin_id   = "greenguard-private-edge"
    vpc_origin_config {
      vpc_origin_id = aws_cloudfront_vpc_origin.edge.id
    }
    custom_header {
      name  = "X-GreenGuard-Origin"
      value = "dashboard"
    }
  }

  default_cache_behavior {
    target_origin_id         = "greenguard-private-edge"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_except_host.id
    compress                 = true
  }

  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    target_origin_id       = "greenguard-private-edge"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.static_assets.id
    compress               = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_cloudfront_distribution" "api" {
  depends_on          = [terraform_data.destroy_inventory_sentinel]
  enabled             = true
  comment             = "${var.cluster_name} mobile BFF"
  price_class         = "PriceClass_100"
  web_acl_id          = aws_wafv2_web_acl.edge.arn
  is_ipv6_enabled     = true
  wait_for_deployment = true
  tags                = { Cell = var.cluster_name }

  origin {
    domain_name = aws_lb.edge.dns_name
    origin_id   = "greenguard-private-edge"
    vpc_origin_config {
      vpc_origin_id = aws_cloudfront_vpc_origin.edge.id
    }
    custom_header {
      name  = "X-GreenGuard-Origin"
      value = "bff"
    }
  }

  default_cache_behavior {
    target_origin_id         = "greenguard-private-edge"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_except_host.id
    compress                 = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

output "edge_urls" {
  description = "AWS-owned trusted HTTPS endpoints; the target group is empty until AWS Load Balancer Controller binds the Istio ingress Service."
  value = {
    web = "https://${aws_cloudfront_distribution.web.domain_name}"
    bff = "https://${aws_cloudfront_distribution.api.domain_name}/graphql"
  }
}

output "edge_target_group_binding" {
  description = "Install AWS Load Balancer Controller/TargetGroupBinding for Istio ingress before expecting health: namespace istio-system, Service istio-ingressgateway, port 80, pod port 8080, target type ip."
  value = {
    target_group_arn = aws_lb_target_group.mesh_ingress.arn
    namespace        = "istio-system"
    service_name     = "istio-ingressgateway"
    service_port     = 80
    pod_target_port  = 8080
  }
}
