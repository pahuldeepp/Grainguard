# Kyverno admission policy

Stage 12 uses Kyverno's stable CEL-based `NamespacedValidatingPolicy` API for
the `greenguard` namespace. This avoids the legacy `ClusterPolicy` API, which
Kyverno documents as deprecated starting in v1.19. Install a Kyverno release
that supports `policies.kyverno.io/v1` and the CLI before applying the policy.
The manifests here do not install Kyverno or execute its code.

`greenguard-pod-baseline.yaml` denies Pod creates and updates unless all regular
and init containers use SHA-256 image digests, containers disable privilege
escalation and writable root filesystems, drop all Linux capabilities, and
declare CPU/memory requests and limits. The pod must set non-root execution
and RuntimeDefault seccomp. Container-level overrides cannot re-enable root or
unconfined seccomp, and no container may add capabilities after dropping ALL.
Ephemeral-container updates are matched through the `pods/ephemeralcontainers`
subresource and checked for digest and container security settings. The policy covers mesh-injected containers
too, so the Istio injector must use hardened, digest-pinned proxy/init images
and resource requests/limits before mesh-enabled workloads can be admitted.

The `tests` folder contains one valid Pod, invalid fixtures that isolate
mutable images, unsafe security settings, missing resource declarations and
unsafe ephemeral-container settings, plus a Kyverno CLI test manifest. Run
`make kyverno-validate` in an environment where the Kyverno CLI is already
available. A YAML syntax parse alone is not evidence that Kyverno accepted the
CEL or that the API server enforced it. Run
`scripts/kyverno-ephemeral-admission.sh` in a disposable cluster with this
policy active to prove the API server rejects an unsafe update through the
ephemeralcontainers subresource. The script creates and removes one test Pod.
The policy remains unapplied until a disposable cluster confirms rejection
behavior.

References: [ValidatingPolicy](https://kyverno.io/docs/policy-types/validating-policy/),
[Kyverno policy type overview](https://kyverno.io/docs/policy-types/overview/),
and [Kyverno CLI tests](https://kyverno.io/docs/subprojects/kyverno-cli/).
