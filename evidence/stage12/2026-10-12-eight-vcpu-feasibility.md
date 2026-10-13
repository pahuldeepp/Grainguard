# Disposable deployment: eight-vCPU feasibility

Owner instruction: deploy with the current eight-vCPU quota, preserving all
services and security controls, unless the minimum safe deployment cannot fit.

## Measured configuration lower bound

`ruby infra/terraform/disposable/minimum-capacity.rb` reads the current required
release inventory, chart/profile requests, the pinned Istio proxy defaults and
the Kafka/RabbitMQ/Redis StatefulSets. It assumes only one application pod each,
even where the actual deployment requires two. This is intentionally optimistic;
it is not an applied configuration or a complete scheduler simulation.

- 33 application containers: 3,375 millicpu.
- 33 Istio proxies: 3,300 millicpu.
- Kafka: 500 millicpu; RabbitMQ: 250; six Redis nodes: 600.
- **Partial total: 8,025 millicpu**, greater than 8,000 physical millicpu.
- Cassandra, OpenSearch, ClickHouse, Connect, schema registry, PgBouncer, Dex,
  AI/ML, observability, controllers, DaemonSets, node reservations and transient
  migration/acceptance jobs are excluded and require additional capacity.

Even this subset cannot schedule at its current requests. More RAM per node
does not increase the CPU quota. Smaller requests would need measured startup
and low-load evidence before being accepted as safe.

## AWS read-only checks

On 2026-10-12, STS confirmed account `580360261589`. Service Quotas in
`us-east-2` returned approved standard On-Demand CPU quota **8.0**. The existing
32-vCPU request `3993b1908ca34478b81df8116a11b1059gaZ54fV` reported **CASE_OPENED**.
No AWS resources were provisioned by these checks.

## Scoped offline checks

- Minimum-capacity tests: **3 tests, 9 assertions passed**.
- Terraform capacity tests: **passed**, covering five native mocked plan/apply
  scenarios and a separate local destroy fixture after quota reduction.
- Review round one found mock values needed `override_during = plan`; fixed
  and the tests passed again.
- Terraform formatting and validation: passed.
- Disposable teardown audit: **15 tests, 197 assertions passed**.
- CodeRabbit second review: **zero findings** on the six implementation,
  test, CI and runbook files.
- Full serial `make verify`: **passed**, process exit code 0. The batch has
  not superseded the active remote CI run.

## Release pin repair

Integrated the exact two-line Kafka pin repair from Claude commit `50e2695`.
Both the CI mirror matrix and platform inventory now use the Apache Kafka
3.9.1 index `sha256:4ceccc577f03f51f6af8dbfda55194d0d892f4fa7913ffbded567ce3895622ed`.
An independent `docker buildx imagetools inspect` succeeded and returned Linux
amd64 and arm64 manifests. Image inventory and digest assembler contract tests
passed. The vendor provenance/signature gate remains blocked; the corrected pin
does not prove a vulnerability scan, signing, image promotion or live Kafka.

No service, security control, replica count, request or scaling configuration
was removed or lowered. No real Terraform apply was run. Full CI, release
images, Karpenter integration, live workload health, application acceptance,
throughput and teardown remain separate gates; this evidence proves neither
live AWS readiness nor performance.
