# GreenGuard iPhone login against a deployed environment

The iOS app already uses Authorization Code + PKCE and stores tokens in the
iPhone Keychain. The checked-in Dex configuration and `127.0.0.1` URLs are for
local development. On an iPhone, `127.0.0.1` means the phone itself.

## Environment that must exist first

1. The disposable Terraform cell declares a Cognito user pool and public
   hosted-login domain, two CloudFront HTTPS distributions, a private ALB,
   Istio ingress and the BFF application tree. These declarations have passed
   local validation, but no real apply has proved that the endpoints are
   reachable or that all workloads are healthy. Obtain the public URLs from
   that cell's outputs after deployment; do not use local loopback URLs.
2. The disposable cell registers a **public native** Cognito client for
   Authorization Code + PKCE (S256), with exactly
   `greenguard://auth/callback` and no client secret. If using another IdP,
   register that callback yourself. Local Dex is a separate development
   configuration that uses a cross-client audience scope.
3. The disposable application values configure BFF verification with the
   Cognito issuer/JWKS, `AUTH_TOKEN_MODE=cognito-access`, both public client
   IDs, and the tenant-control-plane membership source. Verify these values
   in the live pod and that JWKS retrieval works. Provision a real user and a
   GreenGuard tenant membership/role for that user's issuer and subject. OIDC
   authentication alone does not grant tenant access. The local
   `infra/oidc/memberships.json` is a development fixture tied to the local
   issuer; it is not the deployed membership source.
4. Use the Terraform-owned Cognito pool for this disposable environment. The
   checked-in local Dex template has memory storage and development passwords
   and must stay local. Cognito users and GreenGuard tenant memberships are
   operator-enrolled outside Terraform state; see
   [first-admin enrollment](disposable-cognito-first-admin.md).

## Build the app for that environment

From `infra/terraform/disposable`, after a successful deployment:

```sh
terraform output -json mobile_deployment_config > ../../../apps/mobile/shell/deployment.local.json
```

Then from `apps/mobile/shell`:

```sh
npm install
npm run configure:aws -- deployment.local.json
(cd ios && LANG=en_US.UTF-8 pod install)
open ios/GreenGuardMobile.xcworkspace
```

`deployment.local.json` and the generated TypeScript config are ignored by
Git. This file contains **public endpoints and client IDs only**. Never put
passwords, OAuth client secrets, signing keys or tokens in it. The configure
command rejects HTTP URLs, placeholder domains and unknown fields, and fixes the callback to the iOS
registered URL scheme. The Terraform output supplies Cognito's hosted
authorization/token endpoints, mobile client ID, CloudFront BFF URL and
`openid email profile` scope. The checked-in example is for Dex and is not
the AWS cell's configuration.
Run the command again and rebuild when endpoint or
client settings change. `npm run configure:reset` removes the deployed
settings. A release build with no deployed settings has sign-in disabled.

In Xcode, select the `GreenGuardMobile` target, choose your Apple signing
team and a bundle identifier owned by that team, then select the connected
iPhone and run. A Debug app needs Metro running and reachable from the phone
to load JavaScript. A Release build bundles JavaScript but still needs valid
signing. Neither path needs App Store approval for your own device. The URL
scheme in both iOS plist files must continue to match the IdP registration.

## Acceptance on the phone

Open the configured app, select live mode if the Debug demo appears, then
sign in through the browser. Verify the redirect returns to GreenGuard, the
alert list/detail loads from the BFF, and an acknowledgement succeeds for a
user with the required role. Sign out and sign in again; test an expired token
and a temporary offline period. Check BFF/IdP logs for issuer, audience and
redirect failures without logging tokens. A 401/403 after successful Dex
login usually means audience or GreenGuard membership/role configuration is
wrong; a failed return to the app usually means the redirect registration or
URL scheme differs. With Cognito, first confirm that the BFF accepts the
access token's `token_use` and `client_id` and maps its `iss|sub` to a tenant.
If resource binding adds `aud`, set `AUTH_AUDIENCE` to that exact API resource.

This physical-device, deployed-environment acceptance has **not** run yet.
Stage 12/13 cloud and load acceptance also remain open.
