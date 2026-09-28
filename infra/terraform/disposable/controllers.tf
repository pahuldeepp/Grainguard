# Terraform owns the bootstrap releases so their uninstall is in the destroy
# graph. Argo CD applications and workload releases are separate, still-gated
# work; these controllers alone do not make the cell deployable.
provider "helm" {
  kubernetes = {
    host                   = aws_eks_cluster.cell.endpoint
    cluster_ca_certificate = base64decode(aws_eks_cluster.cell.certificate_authority[0].data)
    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", aws_eks_cluster.cell.name, "--region", var.aws_region]
    }
  }
}

resource "helm_release" "aws_load_balancer_controller" {
  name      = "aws-load-balancer-controller"
  namespace = "kube-system"
  chart     = "${path.module}/../../helm/controller-charts/aws-load-balancer-controller-1.14.0.tgz"
  version   = "1.14.0"
  atomic    = true
  wait      = true
  timeout   = 900
  values = [
    file("${path.module}/../../gitops/disposable/aws-load-balancer-controller-values.yaml"),
    yamlencode({
      clusterName = aws_eks_cluster.cell.name
      region      = var.aws_region
      vpcId       = aws_vpc.cell.id
    }),
  ]
  depends_on = [
    aws_eks_node_group.general,
    aws_eks_access_policy_association.cluster_admin,
    aws_eks_pod_identity_association.alb_controller,
  ]
}

resource "helm_release" "istio_base" {
  name             = "istio-base"
  namespace        = "istio-system"
  create_namespace = true
  chart            = "${path.module}/../../helm/controller-charts/base-1.30.5.tgz"
  version          = "1.30.5"
  atomic           = true
  wait             = true
  timeout          = 900
  depends_on       = [aws_eks_node_group.general, aws_eks_access_policy_association.cluster_admin]
}

resource "helm_release" "istiod" {
  name       = "istiod"
  namespace  = "istio-system"
  chart      = "${path.module}/../../helm/controller-charts/istiod-1.30.5.tgz"
  version    = "1.30.5"
  atomic     = true
  wait       = true
  timeout    = 900
  depends_on = [helm_release.istio_base]
}

resource "helm_release" "istio_ingressgateway" {
  name      = "istio-ingressgateway"
  namespace = "istio-system"
  chart     = "${path.module}/../../helm/controller-charts/gateway-1.30.5.tgz"
  version   = "1.30.5"
  atomic    = true
  wait      = true
  timeout   = 900
  values = [yamlencode({
    service = {
      type = "ClusterIP"
      ports = [
        { name = "status-port", port = 15021, protocol = "TCP", targetPort = 15021 },
        { name = "http2", port = 80, protocol = "TCP", targetPort = 8080 },
      ]
    }
    replicaCount = 2
    autoscaling  = { enabled = false }
  })]
  depends_on = [helm_release.istiod, helm_release.aws_load_balancer_controller]
}

resource "helm_release" "keda" {
  name             = "keda"
  namespace        = "keda"
  create_namespace = true
  chart            = "${path.module}/../../helm/controller-charts/keda-2.21.0.tgz"
  version          = "2.21.0"
  atomic           = true
  wait             = true
  timeout          = 900
  depends_on       = [aws_eks_node_group.general, aws_eks_access_policy_association.cluster_admin]
}

resource "helm_release" "argo_rollouts" {
  name             = "argo-rollouts"
  namespace        = "argo-rollouts"
  create_namespace = true
  chart            = "${path.module}/../../helm/controller-charts/argo-rollouts-2.43.2.tgz"
  version          = "2.43.2"
  atomic           = true
  wait             = true
  timeout          = 900
  depends_on       = [aws_eks_node_group.general, aws_eks_access_policy_association.cluster_admin]
}

resource "helm_release" "argocd" {
  name             = "argocd"
  namespace        = "argocd"
  create_namespace = true
  chart            = "${path.module}/../../helm/controller-charts/argo-cd-10.9.2.tgz"
  version          = "10.9.2"
  atomic           = true
  wait             = true
  timeout          = 900
  values = [yamlencode({
    server = { service = { type = "ClusterIP" } }
    configs = { cm = {
      "admin.enabled" = "false"
      # Argo CD does not assess child Application health by default. Restore
      # it so data, RDS bootstrap, and owner migrations must become Healthy
      # before wave 30 runtimes sync.
      "resource.customizations.health.argoproj.io_Application" = <<-LUA
        hs = {}
        hs.status = "Progressing"
        hs.message = "Waiting for child Application health"
        if obj.status ~= nil and obj.status.health ~= nil then
          hs.status = obj.status.health.status
          if obj.status.health.message ~= nil then
            hs.message = obj.status.health.message
          end
        end
        return hs
      LUA
    } }
  })]
  depends_on = [helm_release.istio_ingressgateway, helm_release.keda, helm_release.argo_rollouts]
}
