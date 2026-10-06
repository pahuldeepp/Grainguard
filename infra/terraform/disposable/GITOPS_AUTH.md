# Private GitOps repository authentication

The disposable Argo CD tree reads the private `pahuldeepp/Grainguard` repository
with a repository-scoped, **read-only Ed25519 deploy key**. Terraform accepts
only the exact SSH repository URL. Do not use a personal GitHub token or
`gh auth token` as Argo credentials.

The public key is registered on the repository's Deploy keys page with write
access disabled. The private key is provided to Terraform only as the ephemeral
`gitops_repository_private_key` variable. Terraform writes it through AWS
Secrets Manager's write-only secret-version field to
`greenguard/<environment>/argocd-repository`; the payload is never recorded in
Terraform state, plan output, Helm values, or Terraform outputs. Before it
installs the Terraform-owned root Application, a guarded local helper reads the
exact AWS secret version and creates the Argo CD repository Secret in namespace
`argocd`. The helper verifies the selected AWS account, disposable EKS cluster,
GitHub URL, and secret version, and withholds key material from its output.
Destroy removes the owned Kubernetes Secret before Argo CD is uninstalled and
Terraform deletes the disposable AWS secret container.

Provide the local key through a secure environment assignment. The command
history should contain only the path, not the expanded key:

```sh
cd infra/terraform/disposable
TF_VAR_gitops_repository_private_key="$(cat /secure/path/repository-readonly-ed25519)" terraform plan
TF_VAR_gitops_repository_private_key="$(cat /secure/path/repository-readonly-ed25519)" terraform apply
```

Use an owner-only key file (`0600`) and do not enable shell tracing, print the
variable, or place key bytes in a `.tfvars` file. Set a new
`gitops_repository_key_version` when rotating the key. Argo's bundled GitHub
host-key set verifies the SSH host. The registered public deploy key is
repository account state and is not an AWS resource; revoke it from GitHub
after the cell is no longer needed.

The membership acceptance probe is separate from repository authentication.
After managed Dex is live and an operator has completed first-admin enrollment,
follow [the one-time membership acceptance token runbook](../../../docs/runbooks/disposable-membership-acceptance-token.md).
It creates the scoped `greenguard-acceptance-oidc-token` Secret through a
stdin-only helper, then enables `membershipEnabled` for the acceptance apply.
The probe validates the JWT against the live issuer/JWKS and derives membership
lookup subject only from verified `sub` claims. It never uses Dex's internal
`userID` value.
