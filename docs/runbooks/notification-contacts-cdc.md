# Notification contact CDC operations

PostgreSQL `notification_contacts` is canonical. Debezium snapshots the table and
streams subsequent row changes to `greenguard.notifications.contacts.cdc.v1`;
the isolated projector decodes the checked-in Avro contract and writes the latest
version to DynamoDB. The compacted topic is the replay source for the projection.
The topic contains tenant IDs and email/phone destinations. Never print message
values, keys, decoded rows, AWS request bodies or DLQ bodies in logs or support
tickets.

## Production broker and Registry access

Provision separate workload identities; do not share the local plaintext setup:

| Identity | Kafka permissions | Schema Registry permissions |
| --- | --- | --- |
| `greenguard-notification-contacts-connect` | Read the dedicated PostgreSQL publication through its database credential; write/describe only `greenguard.notifications.contacts.cdc.v1` and `greenguard.notifications.contacts.heartbeat.v2`; manage its own Connect group and internal offset/config/status topics | Read/write only those two `<topic>-value` subjects while registering the pinned contracts |
| `greenguard-notification-contacts-projector` | Read only the two topics above; join only `greenguard-notification-contacts-dynamodb-v1`; write only `greenguard.notifications.contacts.cdc.dlq.v1` | None at runtime beyond fetching schemas needed by the Avro decoder |
| `greenguard-notification-contacts-recovery` | Read only the DLQ and approved source topics; no publish or consumer-group access unless performing an audited recovery | Read only the two contact subjects |

Use TLS in transit, encrypted broker/Registry storage, secret-manager sourced
credentials, topic-scoped ACLs, and audit recovery access. No dashboard, BFF,
general notification worker, or tenant workload receives Kafka read access to
contact CDC. Local development intentionally runs the stack without Kafka ACLs and
must not be exposed to a network.

The contact topic must remain `cleanup.policy=compact` without a short delete
retention so one latest value per tenant remains available for a DynamoDB rebuild.
Only versioned contact clears are published; physical deletes are prohibited.
The recoverable DLQ uses `cleanup.policy=delete` and `retention.ms=604800000` (7
days); export a quarantined item only through the audited recovery process before
expiry. The contact topic and DLQ are PII stores and must be included in the data
retention/deletion review.

## Contract and connector startup

`make events-up` applies the subject-level `BACKWARD` policy, checks and registers
the checked-in Avro contracts, starts each connector, waits until its connector
and task are `RUNNING`, then compares Schema Registry's actual latest schemas to
the artifacts. A mismatch blocks startup/release. Never change a v1 contract in
place: use a new versioned topic and subject for incompatible changes. The
heartbeat uses v2 because its payload was flattened and minimized to avoid
unrelated Debezium 64-bit metadata.

Check service status without reading payloads:

```bash
curl -fsS http://127.0.0.1:58083/connectors/notification-contacts/status
curl -fsS http://127.0.0.1:58081/subjects/greenguard.notifications.contacts.cdc.v1-value/versions/latest
curl -fsS http://127.0.0.1:58081/subjects/greenguard.notifications.contacts.heartbeat.v2-value/versions/latest
```

The Schema Registry responses contain field names/types; never paste registry
examples containing tenant data from Kafka records.

## Recovery and alerting

- Watch `greenguard_notification_contacts_source_to_apply_lag_seconds`, projector
  failures/quarantines, and heartbeat age. Page if CDC heartbeat age or source to
  apply lag exceeds 30 seconds; `/readyz` goes unready after 60 seconds.
- On transient DynamoDB/Kafka outage, keep the projector running: it retries and
  Kafka offsets remain uncommitted until a successful conditional write or
  durable DLQ publish.
- For an invalid event, verify the reason code and source coordinates first. The
  original recoverable value is base64-encoded in the restricted DLQ. Do not add
  PII to logs or paste it into a ticket. Correct the producer/contract, then
  replay via the audited recovery procedure.
- If compacted-topic offsets have expired, restore projection state from the
  canonical PostgreSQL snapshot with a new controlled connector snapshot, then
  resume from its persisted slot/offset. Do not create a second connector against
  the same logical slot.


## Distributed Connect failover

Run production Kafka Connect in distributed mode with multiple workers in the
same Connect group, sharing durable, replicated config/offset/status internal
topics. Deploy exactly one logical `notification-contacts` connector and its one
PostgreSQL replication slot/publication. A failed worker's task is reassigned by
Connect to another worker using the persisted offsets and the same slot. The
PostgreSQL source task is single-owner; duplicate connectors/slots are not a
redundancy strategy. Monitor task failure and replication-slot WAL retention;
repair the worker/connector and resume before WAL retention is exhausted. During
planned failover, never run two independent connector clusters against that slot.

## Durable critical-delivery freshness checkpoint

The projector conditionally writes the transactional source heartbeat to the
same `NOTIFICATION_STATE_TABLE`, under the internal reserved partition
`tenant_id = SYSTEM#NOTIFICATION_CONTACTS_CDC` and sort key
`record_key = CONTACTS_FEED_HEARTBEAT`. The only freshness attribute is numeric
`source_time_ms` (UTC Unix epoch milliseconds). These identifiers are the shared
projector/Lambda interface. API tenants must be UUIDs and cannot select this
system partition. This item contains no contact PII.

The conditional write accepts a heartbeat only if its `source_time_ms` is newer
than the stored value; duplicate/older replays are successful no-ops. Its Kafka
offset is committed only after the durable checkpoint write succeeds. `/readyz`
requires a running consumer and a source heartbeat no older than 60 seconds.
Critical Lambda performs a strongly consistent read of this checkpoint before any
contact lookup and again before each channel's delivery claim/provider send. It rejects/retries delivery when
the checkpoint is missing/malformed, older than 60 seconds, or more than 5 seconds
in the future (the permitted source/Lambda clock skew). SQS eventually moves an
unrecovered failure to the alarmed DLQ; recovery first restores the CDC feed and
then redrives the original record. The same 60-second bound is used by `/readyz`.
Do not use a tenant CONTACTS row's last-update timestamp as feed health: a tenant
can legitimately leave its destinations unchanged for months. Contact rows keep
their own monotonic versions, independently of this source heartbeat.

A fetched schema followed by deterministic Avro payload failure is quarantined;
invalid wire framing is also quarantined. Registry schema lookup/network outages
remain retryable, including a missing schema that an operator can restore.
DLQ `raw_base64` is the exact original Kafka value bytes, preserving binary Avro
for audited replay; exception messages never appear in DLQ headers or metrics.
