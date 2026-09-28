# GreenGuard Falco runtime rules

The GreenGuard rules detect noninteractive shell execution and attempted access to the AWS
instance metadata endpoint from containers in the `greenguard` namespace.
Events include namespace, pod, container, image, process, and network endpoint
identity, while omitting command-line arguments that could contain secrets.
Falco's structured stdout event must be collected by the cluster log pipeline
and routed to the owned alerting destination; writing an event to stdout alone
is not proof that an operator receives an alert.

The pinned deployment baseline uses Falco Helm chart 9.1.0 and
`helm-values.yaml`. The values pin the Falco rules artifact and metadata plugin
versions, enable container/Kubernetes metadata collectors and JSON output, and
configure Falcosidekick's Alertmanager output. The operator must supply
the full Alertmanager URL, including `http://` or `https://`, and load the custom rules file as a Helm file
value:

```sh
helm upgrade --install falco falcosecurity/falco --version 9.1.0 \
  --namespace falco --create-namespace \
  --values infra/falco/helm-values.yaml \
  --set-file 'customRules.greenguard_rules\.yaml=infra/falco/greenguard_rules.yaml' \
  --set-string falcosidekick.config.alertmanager.hostport="$FALCO_ALERTMANAGER_HOSTPORT"
```

Do not install until external image/artifact digests, node driver support, and
the Alertmanager URL have been reviewed for the target cluster. `falco.yaml`
is a raw-Daemon configuration overlay for JSON stdout; it does not install the
container or Kubernetes metadata plugins on its own. The `container` and
`spawned_process` macros and Kubernetes container metadata must be available.
Validate rule syntax with `scripts/falco-validate.sh` using an approved Falco
installation. Then, in a disposable cluster, run a controlled shell process
and an attempted connection to `169.254.169.254` from a test container in the
`greenguard` namespace, and verify both events reach Alertmanager. Do not run
the metadata probe from a shared or production cluster.

This repository does not install Falco or a privileged DaemonSet. Kernel,
runtime socket, eBPF/driver support, image digest, node permissions, event
retention, and alert routing are environment-specific inputs. Stage 12.11
remains in progress until rule validation, controlled event capture, and alert
delivery are proven.

References: [Falco rule examples](https://falco.org/docs/reference/rules/examples/),
[supported rule fields](https://falco.org/docs/reference/rules/supported-fields/),
and [Falco CLI arguments](https://falco.org/docs/reference/daemon/cli-arguments/).
