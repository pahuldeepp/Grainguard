# Stage 05d validation — search indexer

Date: 2026-09-24. Status: implementation and local live gate passed; Stage 05 overall remains subject to the other slices and shared CI.

Implemented `services/search-indexer` as an independent Kafka consumer of canonical device and facility inventory topics. It writes tenant-keyed documents to Elasticsearch 8.13.0 using aggregate external versions, merges partial device updates only after the immediate predecessor, handles each bulk item separately, durably quarantines permanent failures, retries transient failures, and commits offsets only after processing. Search adds a tenant term filter. Rebuilds use a separate versioned index and group, compare exact trusted identity/version/content-hash manifests, and switch aliases atomically. Same-version content collisions and missing device predecessors hold the Kafka offset.

`SEARCH_KAFKA_LIVE=1 node scripts/search-test.mjs` passed against live Elasticsearch and Kafka. Full output: [STAGE_05D_SEARCH_TEST.log](STAGE_05D_SEARCH_TEST.log). The test covers replay idempotence, two-tenant isolation, exact identity/version/content comparison and alias swap, and actual Kafka facility event consumption. Unit cases cover partial device updates, missing predecessor refusal, invalid event quarantine, per-item mapping failure quarantine, transient retry, same-version collision refusal, Kafka commit ordering and tenant query enforcement. Python unit coverage is 83% for `search_indexer.py` after the review fixes.

The Kafka test initially found that `greenguard.inventory.facility.v1` was absent from the running broker. `node scripts/kafka-topics.mjs` provisioned the plan's topic, after which the full gate passed. The search overlay is opt-in. A disposable alias and unique test tenants/indexes prevent the live gate from modifying the production alias.

A scoped CodeRabbit CLI review completed after these gates. It found that an
equal-version replay of a partial device event could hold the Kafka offset
because the stored document includes earlier fields. The consumer now compares
only incoming fields for duplicate detection, skips stale versions, and stops
on conflicting equal-version content. It also closes on SIGTERM/SIGINT, bounds
manifest mismatch diagnostics, and uses a unique alias even when the live test
is invoked directly. The updated 12-unit-test suite and live Elasticsearch/Kafka
gate pass.

Limits: the live gate uses a synthetic Kafka facility event, not the full device-service → outbox → CDC chain. Manifest comparison consumes a trusted JSON map supplied by the operator; it does not itself query the read database. Delete propagation awaits a canonical delete event. No remote CI or Sonar gate is claimed here.

## Search alias promotion safety follow-up (2026-09-24)

An independent review found a race between target-manifest comparison and alias
switch: a concurrent index write could change the target after verification.
Promotion now uses Elasticsearch's acknowledged add-write-block API before
refresh and comparison. That API waits for in-flight writes to drain. The block
remains through the atomic alias update and is removed in `finally`, including
on manifest mismatch or alias failure. A pre-existing operator write block is
preserved. HTTP 401/403 bulk-item failures now stop consumption without Kafka
offset commit or quarantine, so a consumer encountering the temporary block
can resume from the same event after promotion.

`python3 -m unittest discover -s services/search-indexer -v` passed 19 tests.
`SEARCH_KAFKA_LIVE=1 node scripts/search-test.mjs` passed the same suite,
live Elasticsearch replay/tenant/alias checks, and Kafka facility ingestion.
The live test deliberately submitted a bad manifest and confirmed the write
block was cleared, then confirmed it was cleared after two successful alias
promotions. The first `make search-test` run exposed that an unset Elasticsearch
write-block setting returns no index entry; the parser was fixed and the final
direct live rerun passed. No remote CI or Sonar result is claimed by this note.

A scoped CodeRabbit CLI review completed with four findings. The review's
device-event failure finding was valid: quarantining a malformed or permanently
rejected device event could commit the only copy of the last aggregate version.
Device events now stop without offset commit for operator repair; site/bin
quarantine policy remains unchanged. Network URL/timeout errors retry with the
existing bounded schedule, and the Kafka live test uses a unique alias and
deletes its index in `finally`. The requested readiness/lag endpoint was a
broader observability enhancement and is not claimed by this gate. After these
changes, the 19-unit-test suite and `SEARCH_KAFKA_LIVE=1 node
scripts/search-test.mjs` both passed, including the live Elasticsearch alias
and Kafka ingestion checks.
