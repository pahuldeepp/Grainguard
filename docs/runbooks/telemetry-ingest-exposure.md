# Telemetry ingest network exposure

The ingest process has a bounded pre-authentication socket-peer bucket and a
global cap on JWT/JWKS, API-key, and M2M credential verification calls. These controls
bound local resource use, but each replica has independent state. Every public
deployment must rate limit `POST /v1/devices/{deviceId}/readings` at its trusted
WAF or ingress before traffic reaches the pods.

For ingress-nginx, set and validate a finite per-client request rate and burst on
the telemetry-ingest Ingress (for example,
`nginx.ingress.kubernetes.io/limit-rps` and `nginx.ingress.kubernetes.io/limit-burst-multiplier`).
Choose values from expected device reconnect bursts, and make sure the controller
uses the actual client address from the trusted load balancer. Configure trusted
proxy/CIDR handling at the ingress; never enable trust in arbitrary forwarded
headers in telemetry-ingest. Set `INGEST_TRUSTED_PROXY_CIDRS` to the narrow CIDRs
for the actual ingress proxies (comma-separated, maximum 64; universal `0.0.0.0/0`
and `::/0` prefixes are rejected). The ingress must
overwrite inbound `X-Forwarded-For` with its verified client address or append that
verified address as the rightmost chain entry. The service trusts a forwarded
chain only when the socket peer is in the configured CIDRs; it walks from the
right and stops at the first untrusted hop. Missing or malformed chains use the
socket peer. With no CIDR configured, forwarded headers are ignored. This setting
changes only the per-peer bucket key; the global concurrent-verification cap always
remains enabled. Confirm the ingress returns a `429` before an
upstream verifier call when a client exceeds its limit.

The current `greenguard-dashboard` Helm chart deploys only the dashboard and its
NetworkPolicy; it does not create a telemetry-ingest Ingress or configure
telemetry-ingest rate annotations. The chart's ingress namespace setting is not
evidence of a rate limit. A telemetry-ingest chart/Ingress must include the
annotations and a NetworkPolicy that allows ingress only from that controller,
before the service is reachable from a public load balancer.

The local staging Compose stack does not publish the telemetry-ingest container
port to the host. Keep it on the private Compose network behind internal callers;
do not add a host port or public routing without an equivalent edge limiter.
Direct service access is still subject to the in-process guard, but it is not a
supported public deployment topology.

Operational checks:

- Inspect the rendered Ingress and NetworkPolicy in the target namespace before
  rollout; verify annotations on the telemetry-ingest route itself.
- Send a burst from one test client and confirm edge `429` responses and no
  additional API-key/M2M verifier traffic beyond the configured edge threshold.
- Confirm changing `X-Forwarded-For` does not change the application socket-peer
  bucket, and check telemetry-ingest's `429` counter during local saturation.
- Recheck the controller's trusted proxy configuration whenever the external
  load balancer or ingress topology changes.
