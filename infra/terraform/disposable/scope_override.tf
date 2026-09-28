# The shared VPC definition lives in ../platform/main.tf. This disposable-only
# override checkpoints the cell scope before any VPC-backed billable resource.
resource "aws_vpc" "cell" {
  tags = { Name = "${terraform_data.cell_scope.output.cluster_name}-vpc" }
}
