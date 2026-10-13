# GreenGuard dashboard chart

This chart defaults to an `apps/v1` Deployment. The optional Argo Rollouts
profile is selected with `rollouts.enabled=true`; when selected, the workload
is rendered as an `argoproj.io/v1alpha1` Rollout with 25% and 50% canary steps,
60-second pauses, and Prometheus analysis after each pause. Failed analysis
aborts promotion so Argo Rollouts can restore stable traffic.

Rollout mode requires the Argo Rollouts CRDs/controller to be installed before
this release and requires explicit `rollouts.analysis.prometheusAddress` and
`rollouts.analysis.successRateQuery` values. The query must measure the
candidate's success rate using the target environment's telemetry labels; the
chart cannot infer those labels. The threshold, interval, sample count and
failure limit are configurable. Do not enable the profile with a placeholder
query or a shared/production Prometheus endpoint until its access path and
query have been verified.

The image value remains a required immutable OCI digest. This chart does not
install Argo Rollouts, Prometheus, Istio, or their CRDs. Helm rendering proves
manifest shape only; failed-analysis rollback must be demonstrated in a
disposable Kubernetes cluster before Stage 12.6 can pass.

For production browser login, set `publicOidc.enabled=true`, an HTTPS
`publicOidc.authority`, public `clientId`, and either audience mode with
`audience`, or Cognito access mode with optional HTTPS `resource`. The chart
mounts a JSON ConfigMap at `/usr/share/nginx/html/config.json`, marks it
read-only, sets the browser CSP issuer origin plus any required
`publicOidc.connectOrigins` for token/userinfo endpoints, and rolls pods when values
change. The dashboard refuses to start its production UI if this file is
missing or invalid. Keep `publicOidc` values public; never include a client
secret, password, signing key, or token. Terraform must register the web
callback URL using the CloudFront hostname before browser sign-in can work.
