#!/usr/bin/env ruby
# Static guard for the two Terraform-owned Pod Identity trust documents.
root = File.expand_path('../../..', __dir__)
checks = {
  'infra/terraform/platform/iam.tf' => ['eventbridge_bridge_pod_identity', 'greenguard', 'eventbridge-bridge'],
  'infra/terraform/disposable/alb-controller.tf' => ['alb_controller_pod_identity', 'kube-system', 'aws-load-balancer-controller'],
  'infra/terraform/disposable/karpenter.tf' => ['karpenter_pod_identity', 'kube-system', 'karpenter']
}
checks.each do |file, (document, namespace, service_account)|
  source = File.read(File.join(root, file))
  start = source.index("data \"aws_iam_policy_document\" \"#{document}\"")
  abort "#{file}: missing #{document}" unless start
  following_resource = source.index("\nresource ", start)
  block = source[start...(following_resource || source.length)]
  abort "#{file}: trust uses unverified aws:SourceArn" if block.include?('aws:SourceArn')
  %W[aws:RequestTag/eks-cluster-arn aws:RequestTag/kubernetes-namespace aws:RequestTag/kubernetes-service-account].each do |key|
    abort "#{file}: missing #{key}" unless block.include?(key)
  end
  abort "#{file}: wrong namespace" unless block.include?("values   = [\"#{namespace}\"]")
  abort "#{file}: wrong service account" unless block.include?("values   = [\"#{service_account}\"]")
  abort "#{file}: missing cluster ARN" unless block.include?('values   = [aws_eks_cluster.cell.arn]')
end
puts 'Pod Identity trust conditions present for the load balancer controller, Karpenter and EventBridge bridge.'
