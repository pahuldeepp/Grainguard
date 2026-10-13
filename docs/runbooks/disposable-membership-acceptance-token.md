# Disposable OIDC membership acceptance token

Managed Dex keeps real-user OIDC. The in-cluster membership acceptance probe
must verify an actual access token and derive `sub` from its verified claims;
the configured Dex password-record UUID is not a membership subject.

This is a deliberate two-phase human gate. The first Terraform apply creates
the disposable cell and hosted Dex with `enable_live_membership_acceptance =
false`. An operator signs in to the cell, enrolls the tenant owner using the
first-admin procedure, and then provides a short-lived **access token** to the
local helper. The second apply enables the membership probe. This cannot be a
single unattended apply because the real owner login and tenant enrollment
must happen after the IdP exists.

## Provision the one-time token

Use an AWS profile authorized only for the selected disposable account and set
the exact scope for the Terraform-created cell and deployed Git revision. Do
not use this in production:

```sh
export GG_OIDC_MEMBERSHIP_SCOPE='{"account_id":"123456789012","region":"us-east-2","environment":"dev","cluster":"greenguard-dev","revision":"<40-character-git-sha>"}'
```

Obtain a short-lived access token through the managed-Dex browser login for the
already enrolled owner. Do not use an ID token, paste the token into a command
argument, or save it in shell history/a file. The following reads it silently
and pipes it to the helper's stdin; it is not placed in an environment
variable or process arguments:

```sh
read -r -s -p 'Paste the short-lived GreenGuard access token: ' GG_ACCESS_TOKEN
printf '\n'
printf '%s' "$GG_ACCESS_TOKEN" | python3 infra/gitops/disposable/oidc-membership-token-lifecycle.py provision
unset GG_ACCESS_TOKEN
```

The helper creates only the fixed Secret
`greenguard/greenguard-acceptance-oidc-token`, checks account/cluster ownership,
sets owner/cell/revision labels, uses a private temporary kubeconfig, and never
prints the token. The in-cluster probe independently verifies RS256 signature,
issuer, audience and token time claims against the deployed Dex JWKS before it
uses the subject. A malformed or expired token is rejected by the probe.

Now enable `enable_live_membership_acceptance = true` for the same Terraform
root and run plan/apply. Argo creates the membership Job only after the Secret
exists. The Terraform workload acceptance gate waits for the exact cell and
revision's Job and fails if its verified active-admin readback fails.

## Remove the token

After the Job succeeds, run the guarded cleanup command. It checks the exact
cell/revision, requires exactly one successful membership Job, and deletes
with Kubernetes UID/resourceVersion preconditions:

```sh
python3 infra/gitops/disposable/oidc-membership-token-lifecycle.py cleanup
unset GG_OIDC_MEMBERSHIP_SCOPE
```

If the probe fails, cleanup intentionally refuses to erase evidence before
inspection. After investigating, `discard` removes only the helper-owned Secret
for the exact same cell/revision:

```sh
python3 infra/gitops/disposable/oidc-membership-token-lifecycle.py discard
unset GG_OIDC_MEMBERSHIP_SCOPE
```

The token remains only in Kubernetes Secret storage until cleanup/discard and
is short-lived at the IdP. Do not capture it in terminal transcripts or
evidence. AWS apply, interactive login, successful membership acceptance, and
teardown must each be recorded separately; offline helper tests are not live
acceptance.
