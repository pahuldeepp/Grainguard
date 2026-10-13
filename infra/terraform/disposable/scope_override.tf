# The shared VPC definition lives in ../platform/main.tf. This disposable-only
# override uses the state-bound cell scope for a stable disposable VPC name.
resource "aws_vpc" "cell" {
  tags = {
    Name        = "${terraform_data.cell_scope.output.cluster_name}-vpc"
    Project     = "GreenGuard"
    Environment = terraform_data.cell_scope.output.environment
    Cell        = terraform_data.cell_scope.output.cluster_name
  }
}
