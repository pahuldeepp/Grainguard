# Disposable controller chart archives

The seven `.tgz` files are the exact chart archives referenced by
`infra/terraform/disposable/controllers.tf`. `lock.json` records their chart
versions, source repositories and SHA-256 hashes. Run
`ruby infra/gitops/disposable/check-controllers.rb` before a release; it checks
every archive, its chart metadata and Terraform's local archive paths.

The archives were fetched with `helm pull --repo <source> --version <version>`.
The SHA-256 lock prevents a later remote chart update from silently changing
this Terraform deployment. It does not prove an upstream signature. A chart
update requires reviewing the extracted chart, replacing the archive,
updating the lock and Terraform version/path together, and rerunning the
controller checker and Terraform validation. Live controller health remains a
separate EKS acceptance requirement.
