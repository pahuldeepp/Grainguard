# Stage 04a part 1 — event infrastructure validation

Date: 2026-09-23. Starting revision: `48202e7`; changes remain uncommitted.
**Implementation present; live acceptance is NOT verified.** Sandbox permissions deny
Docker Desktop's socket, outbound registry DNS and local Connect HTTP access.
No commit, push, remote CI run or successful CodeRabbit verdict was produced.

## Implemented scope

Opt-in KRaft/Registry/Connect overlay; five domain topics plus required internal
storage topics; logical WAL; idempotent dedicated CDC login; migrator-owned outbox-only
SELECT policies/publications; credential-provider connector configs; topic/connector
provisioning; E01/R1/E02 raw-event smoke; separate CI job. No transformer or binding
transport. The Stage 04 milestone remains in progress.

D01 keeps the existing tenant-policy counts (inventory 7, telemetry 8) and separately
asserts one CDC policy. A database test checks both source databases: CDC login flags,
only outbox table privileges, no write grants, forced RLS, scoped publication, visibility
of two tenants without tenant context, and denied ordinary reads from devices/readings.
These database tests have been authored and typechecked, but could not run here.

## Image pins and provenance — pull verification still required

| Image / intended tag                                    | Pinned digest                                                             | Observation                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apache/kafka:3.9.1`                                    | `sha256:4ceccc577f03f51f6af8dbfda55194d0d892f4fa7913ffbded567ce3895622ed` | Publisher Docker Hub index digest; CLI resolution/pull blocked                                |
| `confluentinc/cp-schema-registry:7.9.1`                 | `sha256:c02aa3d6409caea9ee707c7dfc98990460f7ee5e9c5535942a3279d8264fe0d1` | Publisher Docker Hub index digest; CLI resolution/pull blocked                                |
| `quay.io/debezium/connect:3.2.0.Final` | `sha256:b79f70f10a4aa97445f61e1c7b6cc8f484018f59d9a90cabc8135d3ae70ad90b` | Pulled by digest and resolved with `docker buildx imagetools inspect quay.io/debezium/connect:3.2.0.Final`; the earlier candidate digest did not exist on Quay |

Sources: publisher [Kafka image](https://hub.docker.com/layers/apache/kafka/3.9.1/images/sha256-5862db4a63a6dd7d46fd14771b10a1b39e069c2c47f17d8e4640f960720a0ead),
publisher [Registry image](https://hub.docker.com/layers/confluentinc/cp-schema-registry/7.9.1/images/sha256-86d995c708a375d3563de2196bbdb2138683eca18c6e79e2465d9ed85d68f80e),
and the unverified [Debezium candidate report](https://docker.aityp.com/image/quay.io/debezium/connect%3A3.2).
No registry-resolved `docker buildx imagetools inspect` or local `RepoDigests` result
was obtained. This does **not** satisfy the requested pull-and-resolve acceptance gate.
In particular, verify Debezium platform support and that the candidate digest exists
before considering the image selection complete. No dependency lockfile was changed.

## Commands actually run

| Command                                                                                                                                        | Actual result                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `docker info`; `docker image ls --digests`                                                                                                     | Docker client present; server socket permission denied                                                                             |
| `docker buildx imagetools inspect apache/kafka:3.9.1`                                                                                          | Registry DNS lookup failed                                                                                                         |
| `docker buildx imagetools inspect confluentinc/cp-schema-registry:7.9.1`                                                                       | Registry DNS lookup failed                                                                                                         |
| `docker buildx imagetools inspect quay.io/debezium/connect:3.1.2.Final`                                                                        | Registry DNS lookup failed; this initial candidate was not used                                                                    |
| `docker buildx imagetools inspect quay.io/debezium/connect:3.2`                                                                                | Registry DNS lookup failed                                                                                                         |
| `docker pull apache/kafka@sha256:4ceccc577f03f51f6af8dbfda55194d0d892f4fa7913ffbded567ce3895622ed`                                             | Docker credential helper error `(-50)`                                                                                             |
| `docker inspect --format '{{json .RepoDigests}}' quay.io/debezium/connect:3.2`                                                                 | Docker socket permission denied                                                                                                    |
| `make verify`                                                                                                                                  | Planning check passed; stopped at `db-up` with Docker socket permission denied; no application tests/build ran through this target |
| `make coverage`                                                                                                                                | Stopped at `db-up`; no new coverage result, 100% gate unverified                                                                   |
| `make smoke`                                                                                                                                   | Stopped at `db-up`; live smoke unverified                                                                                          |
| `make events-up && make events-test && make events-down`                                                                                       | `events-up` stopped at `db-up`; subsequent chained commands did not run                                                            |
| `make events-test` (separate attempt)                                                                                                          | Connect fetch failed: `EPERM 127.0.0.1:58083`; no CDC assertions ran                                                               |
| `make events-down` (separate cleanup attempt)                                                                                                  | Docker socket permission denied; this session could not start or stop containers                                                   |
| `npm run lint`                                                                                                                                 | Passed                                                                                                                             |
| `npm run typecheck`                                                                                                                            | All workspaces passed, including Prisma generation and the new CDC test                                                            |
| `npx prettier --write 'scripts/*.mjs' services/device-service/src/migrations.test.ts infra/kafka/compose.yaml 'infra/kafka/connectors/*.json'` | Passed; unrelated scripts unchanged                                                                                                |
| `docker compose --env-file .env -f infra/compose/compose.yaml -f infra/kafka/compose.yaml config --quiet`                                      | Passed without daemon access                                                                                                       |
| `docker compose --env-file .env -f infra/compose/compose.yaml config --services`                                                               | Only postgres, pgbouncer                                                                                                           |
| `docker compose --env-file .env -f infra/compose/compose.yaml -f infra/kafka/compose.yaml config --services`                                   | Adds kafka, schema-registry, connect                                                                                               |
| `git diff --check`                                                                                                                             | Passed                                                                                                                             |
| `coderabbit review --plain --type uncommitted`                                                                                                 | Installed CLI rejected old flags                                                                                                   |
| `coderabbit review --agent --uncommitted --include-untracked`                                                                                  | Corrected flags; authentication callback server failed to start (sandbox loopback restriction). No review verdict                  |

A random `CDC_DB_PASSWORD` was added only to the existing ignored local `.env` using
Node crypto, without printing it. Full `make bootstrap` was not run here: existing
installed dependencies were used; CI runs bootstrap from a fresh checkout.

## Review fixes and remaining acceptance

Repository-requested architecture/tenant review found and fixed Debezium 3.2 entrypoint
mapping: replication/partition worker settings need `CONNECT_`; offset flushing uses
`OFFSET_FLUSH_INTERVAL_MS`. It also found Kafka 3.9.1 console-consumer idle timeouts can
exit 0, so the observation accepts exit 0/1 only with the timeout marker and at least
30 seconds elapsed. A 60-second watchdog fails stalled observers. No runtime success is inferred from
these source-based fixes.

Remaining: successful pulls and primary digest verification, fresh/existing-volume
migrations, idempotent startup, all Go/TS database tests and 100% coverage, ordinary smoke,
raw CDC snapshot/rollback/restart assertions, CI execution, CodeRabbit verdict and Sonar
quality gate. Full E03–E05, canonical registry mapping, broker outage resilience and R7
binding-feed freshness are outside this part and remain open. See
[event infrastructure](../docs/EVENTS_INFRA.md) for operation and recovery constraints.

Final static checks after review fixes: `npm run lint`, `npm run typecheck`,
`npm run format:check`, `make check-plan`, Compose `config --quiet`, and
`git diff --check` passed. `GOCACHE=/private/tmp/greenguard-events-go-cache go test
-run '^$' ./migrations` from `services/telemetry-ingest` passed compilation only
(`[no tests to run]`); it did not execute migration assertions. Prettier was also
run on the new event documentation and evidence; `gofmt -w
services/telemetry-ingest/migrations/migrate_test.go` formatted the changed Go test.

Final architecture/tenant re-review confirmed the timeout fix and separate CDC policy
counts, with no remaining concrete code blocker found by inspection. It did not
substitute for CodeRabbit or runtime acceptance.
