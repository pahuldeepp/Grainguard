# Review dispositions

Authenticated CodeRabbit reviews and independent agent reviews were used for
this local slice. Review logs are under the sharding progress directory; Node
fixture/capacity review logs also have temporary local copies. A review result
is not a substitute for executed tests or live infrastructure acceptance.

## Corrected findings

- Cache policy bypass origins now enter the same fair PostgreSQL queue.
- Pending watermark admission receives cancellation.
- Cold-store minimum checks run before primary entitlement lookup.
- Oversized aggregate responses use a non-retryable 422 response.
- Admission retains its short timeout; business SQL uses the remaining original
  request budget. Expired snapshots cannot commit, and an old finished lease
  cannot discard a pooled client that a new operation has checked out.
- Aggregate JSON preserves BIGINT text, timestamp serialization and NUMERIC
  field parity with the existing individual read helpers.
- Cache guard/fill authority admission is bounded even when a test authority
  ignores cancellation.
- Pool capacity is configurable; pure local saturation returns `read_busy`
  without quarantining the endpoint. Mixed connectivity failures retain the
  freshness/unavailable classification.
- Placement fetch, JSON parsing and rejected-body cleanup share one timeout.
- Invalid and expired read-lease timestamps reject before an HTTP request.
- Owner database construction schedules cleanup for previously allocated handles
  if later allocation fails, preserving the original creation error.
- Notification capacity waits precede database transactions; the admitted
  provider call still holds the ownership fence through ledger completion.
- Legacy live fixtures explicitly establish trusted placement. Cancellation in
  their tracer callbacks permits rollback rather than exiting a goroutine while
  it still owns a transaction.

## Suggestions not applied

- Permitting missing shard settings for legacy writes would weaken mandatory
  tenant ownership admission. Tests now supply explicit trusted placement.
- A physical Prisma fixture handle is still routed: `createOwnerDatabase`
  registers it in the runtime WeakMap. Keeping that handle supports raw unscoped
  denial tests; a production route/fence bypass was not introduced.
- Read-lease admission has no separate caller-supplied intended tenant. Acquire
  validates the requested tenant; Read API context rejects a foreign lease;
  authority admission looks up the lease under its tenant path. Adding a second
  untrusted routing hint would not replace those checks. Malformed expiry
  validation was corrected without changing this authority model.
- Reusable per-pod grants remain a separate protocol requiring expiry/drain and
  partition proofs plus load measurements. Request leases remain enabled.
