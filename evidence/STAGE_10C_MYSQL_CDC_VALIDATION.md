# Stage 10c MySQL snapshot and CDC local validation

**Status:** post-fix local acceptance passed. `make mysql-cdc-test` exited 0 with 30/30 tests, `STAGE10C_LIVE_PASS`, and successful fixture cleanup. Independent review approved, and final CodeRabbit review completed with 0 findings. The first remote `mysql-cdc-integration` CI run remains pending. This is not a production partner integration or managed Debezium HA claim.

Run from the repository root after `make bootstrap`:

```bash
make mysql-cdc-test
```

The command starts a pinned MySQL 8.4.7 Compose overlay alongside the existing Kafka/Connect/Postgres stack, verifies ROW binlog and FULL row image, applies the SQLAlchemy/Alembic partner schema, provisions explicit inventory/schema-history/DLQ/parked topics, registers the Debezium MySQL connector in Kafka Connect's persistent metadata, builds Device Service, runs the lab unit suite, and executes `labs/mysql-cdc/live_test.py`. The live test uses two disposable PostgreSQL tenants and a local RS256 client-credentials issuer with a tenant-bound lookup fixture. The importer POSTs only to the authenticated Device Service command; it has no canonical DB credentials.

The post-fix local `make mysql-cdc-test` transcript (`.local/mysql-cdc-after-review.log`) exited 0 with **30/30** lab tests passing, `STAGE10C_LIVE_PASS`, and successful run-scoped cleanup. It verifies these checks:

- Six site/bin/device records inserted before connector registration arrived as Debezium `op=r` snapshot events and were admitted for two tenants.
- A child consumed before its imported site parent was withheld and confirmed to the DLQ. The live redrive first encountered the unresolved child, appended the exact same DLQ envelope to the same partition tail with `redrive_attempt=1`, and committed the old DLQ offset only after confirmation. It then admitted the parent waiting behind the child and replayed the child at its original source coordinate.
- A persistent orphan exhausted three confirmed tail requeues, was durably parked with the unchanged envelope and `park_reason=parent_dependency`, and freed the DLQ partition only after parked publication was confirmed. Parked redrive failed closed while the parent was missing; after importing the parent, operator repair replay admitted the child.
- A binlog site update reached canonical PostgreSQL; connector restart resumed from the retained binlog offset.
- After Device Service committed an update, the test injected a failure before Kafka offset commit. A **new Kafka consumer in the same group** received the identical uncommitted key/value/coordinate; replay produced no second canonical outbox event.
- An older offset returned `stale` without mutating the current site.
- A MySQL device delete became canonical soft-delete status; a facility delete was quarantined while the canonical site remained.
- An unmapped source tenant was quarantined without a canonical import-state row. Tenant A's application-role RLS context could not read tenant B's site.

The live run exposed Debezium 3.2's actual snapshot markers (`first`, `first_in_data_collection`, `last_in_data_collection`, `last`); the Task 1 normalizer and its regression test were updated to accept those markers only on snapshot reads.

Task 4 review follow-up: the live Alembic DSN now URL-encodes the CDC password, including reserved characters. The migration passes newly constructed, unbound columns and constraints to Alembic; its offline DDL and a fresh live migration both passed. The review-fix target passed on repeated runs; the final run exited 0 and printed `PASS run-scoped MySQL database removed` and `PASS cleaned run-scoped MySQL, Kafka and PostgreSQL fixtures`. The cleanup waits for the run-specific Kafka topics to disappear, deletes the generated MySQL database, and removes only the two generated fixture tenants and their inventory/audit/outbox/import rows. All source, DLQ, child-first and resumed Kafka consumers close. `MYSQL_CDC_PRESERVE_FAILED_FIXTURES=1` is the explicit debugging opt-in to retain failed-run fixtures; the default cleans both successful and failed runs. The shared stable profile's `partner_inventory` database and Kafka Connect metadata remain in place for subsequent runs.

The redrive unit gate proves child-before-parent ordering, a bound of three confirmed requeues, durable parking after exhaustion, no offset commit when DLQ/parked publication is unconfirmed, and operator replay only after the parent is imported. A malformed attempt header also fails closed. Cleanup tests force one step to fail and prove the later PostgreSQL/Kafka/MySQL steps still run, while diagnostics expose only fixed step names and exception classes and preserve the primary live-test failure. The live cleanup runner uses this same independent-step behavior; incomplete cleanup makes an otherwise passing live run fail visibly. The earlier pre-fix transcript `.local/mysql-cdc-final-hardening-2.log` is superseded by `.local/mysql-cdc-after-review.log` (both ignored local artifacts).

Limits: independent review approved and final CodeRabbit review reported no findings. The local OAuth issuer and control-client lookup are test fixtures, not an external IdP or production control plane. The critical signed token, scope, tenant and source checks do run through Device Service. Connector metadata persists in the local Kafka volume, while the test connector itself uses a unique throwaway database/topic generation. Raw-byte DLQ records may contain partner data; production requires restricted ACLs/TLS, retention and an operator redrive procedure. The CI job has been added but cannot be marked passing until a pushed commit runs it. No cloud provider, real partner credentials or mTLS were used.
