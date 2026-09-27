# Stage 12.10 — admission policy static record

Date: 2026-09-26

## Implemented

Selected Kyverno's stable CEL-based `NamespacedValidatingPolicy` API and added
an enforce-mode policy for namespace `greenguard`. It requires digest-pinned
images, non-root Pod execution, RuntimeDefault seccomp, no privilege escalation,
read-only container root filesystems, dropped ALL capabilities with no added
capabilities, and CPU/memory requests and limits. Container-level overrides
cannot re-enable root or unconfined seccomp. The rules include normal, init and
ephemeral containers; the match rule explicitly includes the
`pods/ephemeralcontainers` update subresource. A live API-server rejection
script exercises that subresource when run in a disposable cluster.
this means the Istio injector's proxy/init images must meet the same baseline.
An example namespace and one valid Pod plus isolated mutable-image,
security-context, resource-limit and combined-invalid Pod fixtures are
included in the Kyverno CLI test manifest.

## Validation and limits

Ruby Psych parsed the namespace, policy and all fixture/test YAML files
without syntax errors. `bash -n scripts/kyverno-validate.sh` and
`bash -n scripts/kyverno-ephemeral-admission.sh` passed. The Kyverno
CLI is not installed in this environment, so CEL evaluation and fixture results
were not executed. The policy has not been applied to a Kubernetes API server;
no admission rejection event is claimed. Use `make kyverno-validate` when the
CLI is already installed, then prove allowed and denied admissions in a
disposable cluster. Stage 12.10 remains in progress.

Kyverno's current documentation marks `ValidatingPolicy` stable since v1.18
and the legacy `ClusterPolicy` API deprecated starting in v1.19: [policy type
overview](https://kyverno.io/docs/policy-types/overview/), [ValidatingPolicy
reference](https://kyverno.io/docs/policy-types/validating-policy/), and [CLI
testing](https://kyverno.io/docs/subprojects/kyverno-cli/).
