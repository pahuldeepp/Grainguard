# MQTT acknowledgement timeout

Alert: `SagaMQTTAckTimeout`.

## Symptom
`asset.configure` stays pending: the device did not return a signed `configured` acknowledgement. After the deadline the saga compensates by releasing the asset, and the release cancels the pending configure receipt.

## Diagnosis
Common checks (run from the repository root after `set -a; . ./.env; set +a`):

```bash
curl -s "$SAGA_METRICS_URL/metrics" | grep ^saga_          # worker gauges and counters
docker compose -p greenguard-dev ps                          # shared containers (never pause or restart them from a runbook)
```

Database checks use the owner role and the count-only functions, which return no tenant data:

```bash
docker exec -e PGPASSWORD=$SAGA_MIGRATOR_PASSWORD greenguard-dev-postgres-1 \
  psql -h 127.0.0.1 -U saga_migrator greenguard_sagas -c "SELECT * FROM saga_state_metrics()"
```

- Pending configure receipts (IDs only): `SELECT count(*) FROM hardware_pending_configuration_ids(100)` as `hardware_migrator`.
- Hardware worker log: `pending hardware configuration blocked` means the asset has no valid acknowledgement key; `MQTT acknowledgement ignored` means a bad signature, topic or identity.
- Broker reachability: `mosquitto_sub -h 127.0.0.1 -p 51883 -t 'greenguard/+/+/ack' -C 1 -W 10`.
- The dispatcher is fair: each claim moves a receipt to the back of the queue, so one silent device cannot starve others.

## Mitigation
1. Restore the broker connection or device; the dispatcher republishes the same command ID until acknowledged.
2. Rotate a missing or short `mqtt_ack_secret` through the registration path.

## Escalation
Escalate to the device/firmware owner for a single asset, and to platform on-call if the broker is unreachable.
