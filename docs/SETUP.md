# Local development

This workspace implements the Stage 01 foundation and the Stage 02a inventory data layer (Prisma models, migrations, forced RLS, PgBouncer, outbox/audit writes and concurrency control). It does not yet implement authenticated HTTP domain APIs, ingestion writes, Kafka, CDC or production deployment. Those remain ordered in the [milestones](MILESTONES.md) and [acceptance backlog](IMPLEMENTATION_BACKLOG.md).

## Start

Install Node **24.21.0**, Go **1.27.1**, Python 3, Make, and Docker with Compose v2 or newer. Node includes npm; the lockfile was generated using npm **11.19.0**. From the GreenGuard folder:

```sh
make bootstrap
make dev
```

Open http://127.0.0.1:5173. The dashboard checks both services through Vite's local proxy every five seconds. A green status means a live database query succeeded. There are no simulated users, devices, throughput figures, or capacity claims.

Bootstrap creates a private ignored `.env` with random local passwords and installs locked Node/Go dependencies. It keeps existing passwords, adds any new ones, regenerates the derived connection URLs, and writes the PgBouncer user list to `.local/pgbouncer/`. `make dev` starts PostgreSQL and PgBouncer, applies migrations, compiles the services and starts the dashboard. React and NestJS changes reload automatically; restart `make dev` after Go changes. Ctrl+C stops the app processes; `make db-down` stops PostgreSQL and preserves its named volume. No cloud resources are created.

| Component             | Local address         | Implemented                                                                                    |
| --------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| React dashboard       | http://127.0.0.1:5173 | Live service readiness, foundation screen                                                      |
| NestJS device service | http://127.0.0.1:3001 | GET /healthz, GET /readyz                                                                      |
| Go telemetry service  | http://127.0.0.1:8080 | GET /healthz, GET /readyz                                                                      |
| PostgreSQL 16         | 127.0.0.1:55432       | Inventory, telemetry, and reserved read databases; direct connections for migrations and tests |
| PgBouncer 1.24        | 127.0.0.1:56432       | Transaction pooling for `inventory_app` runtime traffic                                        |

All listeners bind to localhost. Service runtime roles cannot administer PostgreSQL or connect to each other's database. Inventory tables are owned by `inventory_migrator`; the runtime role `inventory_app` has no DELETE, cannot update identity columns and cannot bypass the forced RLS policies. Tenant isolation is proven by the D02/D03 tests, not by the roles alone.

## Verification

```sh
make db-migrate  # start PostgreSQL + PgBouncer and apply migrations
make verify    # plan links, migrations, formatting, lint, types, unit + database tests, Go race/vet, builds
make smoke     # Docker database, actual readiness, failure responses, DB privilege isolation
```

The smoke test uses ports 13001, 13002, 18080 and 18081 and stops its own service processes on completion. PostgreSQL remains running until `make db-down`. Avoid running multiple smoke tests simultaneously.

The CI workflow runs bootstrap, verify, and smoke as one failing-on-error job. Configure `required-foundation` as a required branch protection check after publishing this repository. A workflow file alone does not configure GitHub branch protection. GitHub CI runs in `pahuldeepp/Grainguard` and passes the 100% SonarQube gate. See [delivery setup](CI_CD.md). Initial local results are in [Stage 01 evidence](../evidence/STAGE_01_VALIDATION.md).

## Data and credentials

The Compose project is named `greenguard-dev` and uses the volume `greenguard-dev_postgres-data`. Roles, databases and their ownership are provisioned by `infra/compose/init-databases.sql`, which is idempotent: PostgreSQL runs it when the volume is first created, and `make db-up` runs it again every time. An existing volume therefore gains new roles (for example `telemetry_migrator`) and database ownership without being recreated, and `.env` passwords are re-applied to the roles, so a rotated password takes effect on the next `make db-up`. Tables that were created earlier by another owner are not moved; if a volume holds nothing you need, recreate it with `docker compose --env-file .env -f infra/compose/compose.yaml down -v` and run `make db-migrate`. Do not delete a volume that contains data you need.

Never commit `.env`, secrets, dependencies, or build outputs. `.env.example` contains placeholders only. The original repositories and GitHub exports remain in adjacent archive folders, separate from this application's source. Historical links outside the repository require that archive; the standalone planning check validates links inside this project only.

## Version choices

Runtime pins: `.nvmrc` and `.go-version`; Node dependency pins and integrity: `package-lock.json`; Go modules: `go.mod` / `go.sum`; PostgreSQL image: digest in Compose. TypeScript 5.9.3 is intentionally compatible with the selected ESLint parser. Nest uses ESM / NodeNext and TypeScript compilation with decorator metadata. The frontend uses React 19 and Vite 8. The legacy technology catalog remains historical evidence rather than the new dependency lockfile.

Reference: [Nest first steps](https://docs.nestjs.com/first-steps), [Nest migration guide](https://github.com/nestjs/docs.nestjs.com/blob/master/content/migration.md), [Vite guide](https://vite.dev/guide/).

## Next implementation

Stage 02 establishes tenant/site/bin/device schemas, migration roles, RLS, authenticated tenant context and two-tenant access tests. Stage 03 adds durable writes and transactional outbox. Implementing these in order keeps the full architecture covered without pretending all services already work.
