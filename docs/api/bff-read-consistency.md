# BFF projection consistency

The read fields in [the GraphQL read contract](../../contracts/graphql/read.v1.graphql)
accept optional `minimumConsistency: String`. The authenticated principal supplies
the tenant. The token is a requested projection minimum and gives no permission,
tenant override, shard selection, or ownership authority.

The value is canonical JSON with exactly five fields:

```json
{"v":1,"tenantId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","shardIncarnation":"11111111-1111-4111-8111-111111111111","placementEpoch":"2","sequence":"9007199254740993"}
```

Epoch and sequence use decimal strings bounded by signed int64. Epoch starts at
one; sequence can be zero. BFF authentication precedes operation resolution and
field validation. The BFF binds a supplied token to the principal tenant,
canonicalizes it, and forwards `x-greenguard-minimum-watermark` on every Read API
attempt. No shared ReadClient field stores a tenant or minimum. Strict `device`
fields bypass the request's device batch loader, so aliases with different
minima cannot share a weaker read result.

`consistencyToken` on `ReadingView`, `DeviceView`, `DevicePage`, `RollupView`,
`BinReadings`, and `BinTrend` comes from the same Read API response's
`x-greenguard-watermark` header. It describes admitted PostgreSQL projection
state. `streamVersion` retains its separate source stream meaning. The BFF
rejects malformed or cross-tenant response tokens and rejects a strict response
with no token, a different incarnation/epoch, or a lower sequence.

Device history and search have independent Cassandra/OpenSearch checkpoints.
A PostgreSQL token never proves their consistency. Clients leave those reads
eventual by default, even after observing a PostgreSQL minimum. An explicitly
requested strict minimum is forwarded and unsupported stores return
`consistency_store_unsupported` (409), which the BFF preserves.

Redis live hints may include `shard_incarnation`, `placement_epoch`, and
`projection_sequence` as a complete identity/sequence tuple. A live subscription
requests at least that watermark before reading latest, preserves an already
observed minimum on legacy hints, and emits the admitted read's token in
`DeviceChange.consistencyToken`. Authenticated hints with a higher placement epoch replace the old identity; late
lower-epoch hints are discarded. A same-epoch incarnation change retains the old
minimum and refetches current authority. An older snapshot completing after a
newer hint is discarded and rerun rather than emitted.

The dashboard stores observed minima on its ReadApi instance, keeps the maximum
sequence within one identity, and refreshes with that minimum. App recreates the
instance when `sessionId` changes. `clearConsistency()` supports an explicit
fresh context; an in-flight response from a cleared context is rejected. Live
changes are observed before the refresh callback.

`MobileReadClient` provides the same read documents, per-instance minima, and
`observeDeviceChange()` for a future live transport. It binds local state to the
session tenant and subject, clears it on sign-out/tenant switch/relogin, and
rejects an in-flight response after context reset. Its GraphQL 401 retry preserves
the variables and refuses to retry under a different tenant or subject. The iOS
shell's current live UI remains an alert journey; adding live reading screens
and a subscription transport is separate product work.

Persisted operation documents and SHA-256 hashes changed together with the
selected token fields. Deploy matching dashboard/mobile clients and BFF registry
versions. Golden hashes and byte-equivalence tests cover the new registry. Every persisted
operation also validates against the runtime GraphQL schema.


## Move and restore recovery

Foreground dashboard/mobile reads and BFF subscription refreshes react only to
HTTP409 `consistency_identity_mismatch`. Each operation permits at most one fresh
admitted snapshot without its old minimum. The returned actual token must bind
to the same authenticated tenant, have an epoch at least as high as the old token,
and name a different incarnation or epoch. An unchanged identity cannot reset or
lower a minimum. Generic errors, outages, replica lag, foreign/missing tokens and
older epochs fail while preserving the old minimum. Sequence numbers across
ownership identities are incomparable: this is an explicit identity reset after
authoritative admission, relying on Task7 activation certifying the completed
copy. No client-supplied token authorizes activation.

Read API actual headers also collect in a request-local BFF certificate. A
successful GraphQL operation exposes `extensions.consistencyToken`, the oldest
sequence across all its same-identity admitted PostgreSQL reads. This covers
null/empty payloads; mixed identities fail the operation. Existing row tokens
remain available. Error responses do not expose a success certificate. The
certificate does not cover Cassandra/OpenSearch or operational alert/provider
stores. Malformed live hints trigger durable refetch with the retained minimum;
they do not permanently poison client state. Session changes invalidate pending
reads and prevent old mobile hints from updating the new session.

## DeviceCurrent aggregate and deadlines

Persisted `DeviceCurrent` preserves its public device/latestReading fields. Both
resolvers share one promise in that authenticated GraphQL request, keyed by device
ID and canonical minimum. ReadClient uses one GET
`/api/v1/read/devices/:deviceId/current`, one operation lease, and one admitted
PostgreSQL transaction. The provider issues one SELECT containing two tenant- and
device-filtered scalar subqueries, each capped at one row. This guarantees one
statement snapshot even in legacy primary mode. Input is one UUID; the response
has at most one device and one latest reading and is capped at256 KiB. It bypasses
uncertified row caches and uses the existing fair PostgreSQL admission queue.

The BFF deadline begins before body parsing and membership verification; all
related reads share its eight-second cap and disconnect signal. Each GET attempt
forwards a decimal `x-greenguard-read-budget-ms` bounded by the remaining operation
budget, its two-second attempt cap and the Read API four-second maximum. Retries
retain the same minimum and consume the original deadline. A subscription's
controlled identity reset shares the refresh deadline; completing the
subscription aborts its in-flight request. Foreground reset and mobile 401 token
refresh also consume one original client deadline. Cancellation is neutral to
the shared upstream circuit breaker.

DeviceCurrent now normally creates one Read API HTTP call/lease; exhausted safe
GET retries can create at most three attempts within the original budget. Generic
ordinary device aliases continue batching at most 100 IDs with duplicate IDs
cached only inside that request. Strict aliases outside DeviceCurrent still use
separate minimum-sensitive GETs. Live subscriptions acquire no lease for the
socket lifetime: initial refresh and each coalesced hint/fallback poll are separate
bounded operations.
