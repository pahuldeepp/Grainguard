# Search indexer (Stage 05d)

This Python consumer indexes device, site and bin inventory events from the two canonical inventory topics. It does not subscribe to telemetry. Elasticsearch 8.13.0 is the Stage 05 engine; the HTTP adapter keeps the query and index contract independent of the engine for a later OpenSearch profile.

The consumer group is `greenguard.search-indexer.v1`. Every document ID is `tenant_id:resource_type:resource_id`, with `tenant_id` mapped as a keyword. The sole public search method adds a tenant term filter. Versioned indices use `greenguard-inventory-v<N>` and the read alias is `greenguard-inventory`. External aggregate versions reject stale or repeated events; partial device events merge with the indexed document only when its stored version is the immediate predecessor. A missing predecessor stops the consumer with the offset uncommitted. All items in a bulk response are inspected. HTTP 409 is accepted only when a newer version is present or the same-version document matches; a same-version content collision stops offset commits for investigation. Transient HTTP and network failures retry. Invalid or permanently rejected device events stop without committing their Kafka offset, preserving the device version chain for operator repair. Permanent site/bin failures are durably appended to a JSONL quarantine file before Kafka's offset is committed. Write blocks and authorization failures hold the offset without quarantine. An exhausted transient failure leaves the offset uncommitted.

Run locally:

```bash
docker compose --env-file .env -f infra/compose/compose.yaml -f infra/search/compose.yaml up -d --wait elasticsearch
python3 -m venv .local/search-venv
.local/search-venv/bin/pip install -r services/search-indexer/requirements.txt
python3 -m unittest discover -s services/search-indexer -v
node scripts/search-test.mjs
SEARCH_KAFKA_LIVE=1 node scripts/search-test.mjs # after make events-up
.local/search-venv/bin/python services/search-indexer/search_indexer.py consume --version 1
```

To rebuild, start `consume --version 2 --group greenguard.search-indexer.rebuild.v2` from earliest retained offsets. Export a trusted manifest for every expected device, site, and bin. Its keys are document IDs and each value contains the aggregate `version` and `sha256` of the canonical JSON document, for example `{"<tenant-id>:site:<site-id>": {"version": 2, "sha256": "<64 hex characters>"}}`. The hash uses sorted JSON keys, no extra spaces, and UTF-8 (`document_hash` in the indexer). Stop the rebuild consumer at a known source barrier and generate the manifest for that same barrier. Run `python services/search-indexer/search_indexer.py promote --version 2 --expected-manifest <file>`. Promotion first applies Elasticsearch's acknowledged write block to the target, which drains in-flight writes, then refreshes and compares every identity, version and content hash through paginated search. It submits one atomic alias update and removes the temporary write block even when comparison or alias update fails. If the index was already write-blocked, the command leaves that operator block in place. A consumer that attempts to write during the block stops without committing its Kafka offset; restart it after promotion so it catches up. Keep the old index for rollback until the new index is validated.

Inventory has no delete event yet. `device.status_changed` carries status, including `deleted`, but the record remains searchable with that status. Tenant deletion propagation requires its own event contract. Search has application-level tenant filtering and no database RLS; callers must use `Elastic.search`, never raw Elasticsearch access.
