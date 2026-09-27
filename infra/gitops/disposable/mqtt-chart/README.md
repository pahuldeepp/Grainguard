# Disposable MQTT broker contract

This chart is a **private broker building block**, not an enabled Argo application. It renders one Mosquitto StatefulSet, a 5 Gi default PVC, a ClusterIP Service on TLS port 8883, and a default-deny NetworkPolicy admitting only hardware worker pods. Its immutable image digest, Secret name and bounded PVC size are required inputs. Run `bash check-chart.sh` for offline render and rejection checks.

The Kubernetes Secret named by `credentialSecret` must already exist in the broker namespace and contain `tls.crt`, `tls.key`, `ca.crt`, `passwords` (Mosquitto password hashes), and `acl` (explicit per-principal topic rules). The chart creates **no secret value** and never permits anonymous clients. Publish to `greenguard/<tenant>/<asset>/ack` and subscribe to `greenguard/<tenant>/<asset>/command` must be granted only to that device principal. A separate hardware worker principal requires publish to `greenguard/+/+/command` and subscribe to `greenguard/+/+/ack`. Do not grant devices broad wildcard access. Keys, credentials, and ACL changes need an owned provisioning/rotation mechanism and a restart/rollout path.

## Secret provisioning gate

Provision the five Secret keys through the disposable environment's managed secret sync, using Mosquitto `$7$` password hashes. Keep the raw worker/device passwords in their separate restricted runtime secrets; do not put plaintext passwords in the broker's `passwords` file. Generate an explicit device inventory JSON with `devices` entries containing `username`, `tenant_id`, and `asset_id`. Before deploying or rotating the broker, run:

```sh
python3 infra/gitops/disposable/mqtt-chart/check-secret.py \
  --secret-json /secure/temporary/mqtt-secret.json \
  --devices-json /secure/temporary/mqtt-devices.json \
  --namespace greenguard-data
```

The input Secret JSON contains sensitive material: restrict its file mode and remove it after validation. The checker prints only a pass/fail reason; it validates the server certificate chain, private-key match, `mqtt.<namespace>.svc.cluster.local` hostname, hash formats, and exact ACL grants. When external ingress is enabled, pass the same `external.hostname` as `--external-hostname`; the checker then requires that name in the server certificate too. It rejects unknown principals and broad device topics. It does not create credentials, prove a successful broker login, or check Secret Manager/Kubernetes equality. Rotation requires validating the new Secret, syncing it, restarting the broker and affected clients, then proving reconnect and acknowledgement delivery. Never revoke a prior device credential before firmware and broker changes have converged.

The server certificate must cover `mqtt.<namespace>.svc.cluster.local`. `MQTT_BROKER_URL` for the hardware worker should be `tls://mqtt.<namespace>.svc.cluster.local:8883`; mount `ca.crt` in that pod and set `MQTT_CA_FILE` to its path. The worker also needs `MQTT_USERNAME`, `MQTT_PASSWORD`, and a stable, unique `MQTT_CLIENT_ID` per worker replica. Its TLS client validates the certificate chain against the mounted CA and checks the broker hostname. Device firmware and certificate trust must be tested separately. The ClusterIP broker is not reachable by physical devices outside EKS. A separately reviewed external device endpoint, with TLS and restricted access, is required before treating physical hardware workflows as live.

One broker replica and one EBS claim provide restart persistence but no broker high availability. Check storage pressure and retained sessions in live acceptance. The EBS CSI claim and volume must be deleted by the disposable teardown before VPC/EKS destruction; this chart alone cannot prove AWS resource cleanup.

## External device endpoint decision

`external.enabled` defaults to `false`. Opt-in renders a separate internet-facing AWS NLB Service forwarding TCP 8883 to the broker's own TLS listener. It also renders a NetworkPolicy allowing only the NLB subnet CIDRs to reach the broker. The chart refuses to render it without a concrete `external.hostname`, narrow IPv4 `external.sourceCIDRs` (/24 through /32), and private RFC1918 `external.nlbSubnetCIDRs` (/16 through /32). The source ranges are applied to the NLB Service and managed frontend security group; no `0.0.0.0/0` is accepted. Verify the resulting AWS security group and NetworkPolicy packet source in a live environment before onboarding devices. The NLB does not terminate TLS, so the firmware must trust the broker certificate and use `external.hostname`; provide DNS separately and run `check-secret.py --external-hostname <same name>` before applying the chart. Keep unique device passwords, exact topic ACLs, and no anonymous or cleartext listener. Remove the Service and its NLB/target groups before EKS/VPC destroy. With no controlled public domain or device fleet configuration yet, external ingress remains disabled and untested. A physical iPhone uses the BFF HTTPS endpoint and does not need direct MQTT access.
