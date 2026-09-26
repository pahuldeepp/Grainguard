.PHONY: bootstrap db-up db-down db-logs db-migrate dev verify check-plan build smoke observability-up observability-down observability-validate observability-test-rules
# Local connection settings from make bootstrap; exported so tests and Prisma see them.
-include .env
export
COMPOSE = docker compose --env-file .env -f infra/compose/compose.yaml
bootstrap:
	node scripts/bootstrap.mjs
db-up:
	$(COMPOSE) up -d --wait --build
	$(COMPOSE) exec -T postgres psql -q -U postgres -d postgres -f /docker-entrypoint-initdb.d/001-databases.sql
db-down:
	$(COMPOSE) down
db-logs:
	$(COMPOSE) logs --tail=100 postgres pgbouncer
db-migrate: db-up
	npm run migrate -w services/device-service
	npm run migrate -w services/workflow-alerts
	cd services/telemetry-ingest && go run ./cmd/migrate
	$(MAKE) projection-migrate
	$(MAKE) risk-migrate
	$(MAKE) jobs-migrate
	$(MAKE) saga-migrate
build:
	npm run build
	mkdir -p build
	cd services/telemetry-ingest && go build -o ../../build/telemetry-ingest .
	cd services/cdc-transformer && go build -o ../../build/cdc-transformer .
	cd services/projection-builder && go build -o ../../build/projection-builder .
dev: db-migrate build
	npm run dev
verify: check-plan db-migrate
	$(MAKE) risk-test
	npm run format:check
	npm run lint
	npm run typecheck
	npm test
	cd packages/kafka-transport && test -z "$$(gofmt -l .)"
	cd packages/kafka-transport && go vet ./...
	cd packages/kafka-transport && go test -race ./...
	cd packages/go-common && test -z "$$(gofmt -l .)"
	cd packages/go-common && go vet ./...
	cd packages/go-common && go test -race ./...
	cd packages/go-migrations && test -z "$$(gofmt -l .)"
	cd packages/go-migrations && go vet ./...
	cd packages/go-migrations && go test -race ./...
	cd services/telemetry-ingest && test -z "$$(gofmt -l .)"
	cd services/telemetry-ingest && go vet ./...
	cd services/telemetry-ingest && go test -race ./...
	cd services/cdc-transformer && test -z "$$(gofmt -l .)"
	cd services/cdc-transformer && go vet ./...
	cd services/cdc-transformer && go test -race ./...
	cd services/projection-builder && test -z "$$(gofmt -l .)"
	cd services/projection-builder && go vet ./...
	cd services/projection-builder && go test -race ./...
	cd services/cassandra-writer && test -z "$$(gofmt -l .)"
	cd services/cassandra-writer && go vet ./...
	cd services/cassandra-writer && go test -race ./...
	cd services/jobs-worker && test -z "$$(gofmt -l .)"
	cd services/jobs-worker && go vet ./...
	cd services/jobs-worker && go test -race ./...
	cd services/saga-orchestrator && test -z "$$(gofmt -l .)"
	cd services/saga-orchestrator && go vet ./...
	$(MAKE) saga-test
	$(MAKE) build
check-plan:
	python3 scripts/check_plan.py
observability-up:
	docker compose -f infra/observability/compose.yaml up -d
observability-down:
	docker compose -f infra/observability/compose.yaml down
observability-validate:
	node scripts/observability-validate.mjs
observability-test-rules:
	docker run --rm --entrypoint promtool -v "$(CURDIR)/infra/observability:/etc/prometheus:ro" prom/prometheus:v3.2.1 check rules /etc/prometheus/rules/platform.yaml
	docker run --rm --entrypoint promtool -v "$(CURDIR)/infra/observability:/etc/prometheus:ro" prom/prometheus:v3.2.1 test rules /etc/prometheus/tests/platform.test.yaml
	docker run --rm --entrypoint promtool -v "$(CURDIR)/infra/observability:/etc/prometheus:ro" prom/prometheus:v3.2.1 check rules /etc/prometheus/rules/brokers.yaml
	docker run --rm --entrypoint promtool -v "$(CURDIR)/infra/observability:/etc/prometheus:ro" prom/prometheus:v3.2.1 test rules /etc/prometheus/tests/brokers.test.yaml
	docker run --rm --entrypoint promtool -v "$(CURDIR)/infra/observability:/etc/prometheus:ro" prom/prometheus:v3.2.1 check rules /etc/prometheus/rules/slo.yaml
	docker run --rm --entrypoint promtool -v "$(CURDIR)/infra/observability:/etc/prometheus:ro" prom/prometheus:v3.2.1 test rules /etc/prometheus/tests/slo.test.yaml
.PHONY: observability-aws-config
observability-aws-config:
	node scripts/render-observability-aws-config.mjs
.PHONY: observability-test-broker-rules
observability-test-broker-rules:
	docker run --rm --entrypoint promtool -v "$(CURDIR)/infra/observability:/etc/prometheus:ro" prom/prometheus:v3.2.1 check rules /etc/prometheus/rules/brokers.yaml
	docker run --rm --entrypoint promtool -v "$(CURDIR)/infra/observability:/etc/prometheus:ro" prom/prometheus:v3.2.1 test rules /etc/prometheus/tests/brokers.test.yaml
	node --test infra/observability/exporters/streaming-state-exporter.test.mjs
.PHONY: observability-runbook-check observability-rehearsal-test observability-rehearse
observability-runbook-check:
	node --test scripts/observability-runbook-check.test.mjs
	node scripts/observability-runbook-check.mjs
observability-rehearsal-test:
	node --test scripts/observability-rehearsal.test.mjs
observability-rehearse: observability-rehearsal-test
	node scripts/observability-rehearsal.mjs
smoke: db-migrate build
	node scripts/smoke.mjs

# Risk engine (Python): pinned venv; live DB tests run when RISK_* URLs are exported
# (from .env) and skip otherwise. risk-migrate applies forward-only SQL as risk_migrator.
RISK_VENV = .local/risk-venv
.PHONY: risk-venv risk-test risk-migrate
risk-venv:
	python3 -m venv $(RISK_VENV)
	$(RISK_VENV)/bin/pip install -q -r services/risk-engine/requirements-dev.txt
risk-migrate: risk-venv
	cd services/risk-engine && ../../$(RISK_VENV)/bin/python -m risk_engine.migrate
risk-test: risk-venv
	cd services/risk-engine && ../../$(RISK_VENV)/bin/python -m unittest discover -s . -p 'test_*.py' -v

.PHONY: coverage sonar-up sonar-init sonar-scan sonar-down staging staging-check staging-down review
coverage: db-migrate
	npm run coverage
sonar-up:
	node scripts/sonar.mjs up
sonar-init:
	node scripts/sonar.mjs init
sonar-scan:
	node scripts/sonar.mjs scan
sonar-down:
	node scripts/sonar.mjs down
staging:
	docker compose --env-file .env -f infra/staging/compose.yaml up -d --build --wait
	$(MAKE) staging-check
staging-check:
	node scripts/staging-check.mjs
staging-down:
	docker compose --env-file .env -f infra/staging/compose.yaml down
review:
	node scripts/review.mjs

.PHONY: deploy rollback
deploy:
	node scripts/deploy.mjs "$(REVISION)"
rollback:
	node scripts/deploy.mjs rollback

# Opt-in event infrastructure; the base stack never loads this overlay.
EVENTS_COMPOSE = $(COMPOSE) -f infra/kafka/compose.yaml
.PHONY: events-up events-down events-test
events-up: db-migrate
	$(EVENTS_COMPOSE) up -d --wait kafka
	node scripts/kafka-topics.mjs
	$(EVENTS_COMPOSE) up -d --wait schema-registry connect
	node scripts/kafka-connect.mjs
events-down:
	$(EVENTS_COMPOSE) stop connect schema-registry kafka
events-test:
	node scripts/events-smoke.mjs

.PHONY: events-e2e
events-e2e:
	node scripts/events-e2e.mjs

.PHONY: lot-events-e2e
lot-events-e2e: events-up
	npm run build -w services/device-service
	node scripts/lot-events-e2e.mjs

.PHONY: wal-check events-faults
wal-check:
	node scripts/wal-check.mjs
events-faults:
	mkdir -p build
	cd services/cdc-transformer && go build -o ../../build/cdc-transformer .
	node scripts/events-faults.mjs

.PHONY: binding-feed-reset
binding-feed-reset:
	node scripts/binding-feed-reset.mjs $(ARGS)

.PHONY: projection-migrate
projection-migrate:
	cd services/projection-builder && go run ./cmd/migrate

.PHONY: projection-replay
projection-replay:
	node --env-file=.env scripts/projection-replay-test.mjs

# Opt-in Cassandra history (Stage 05c); never part of dev/verify/smoke.
CASSANDRA_COMPOSE = $(COMPOSE) -f infra/cassandra/compose.yaml
CASSANDRA_HOSTS ?= 127.0.0.1:59042
.PHONY: cassandra-up cassandra-down cassandra-test
cassandra-up:
	$(CASSANDRA_COMPOSE) up -d --wait cassandra
	cd services/cassandra-writer && go run ./cmd/migrate
cassandra-down:
	$(CASSANDRA_COMPOSE) stop cassandra
cassandra-test:
	cd services/cassandra-writer && CASSANDRA_HOSTS=$(CASSANDRA_HOSTS) CASSANDRA_LIVE=1 go test -count=1 -race -run 'Live' -v ./...

# Destructive, opt-in local fault gate: briefly stops and restarts Cassandra.
.PHONY: history-test
history-test:
	cd services/cassandra-writer && KAFKA_BROKERS=127.0.0.1:59092 CASSANDRA_HOSTS=$(CASSANDRA_HOSTS) CASSANDRA_LIVE=1 KAFKA_CASSANDRA_LIVE=1 KAFKA_CASSANDRA_FAULT_LIVE=1 go test -count=1 -race -run 'Live' -v .
	$(MAKE) cassandra-up
	cd services/cassandra-writer && CASSANDRA_HOSTS=$(CASSANDRA_HOSTS) CASSANDRA_LIVE=1 go test -count=1 -race -run 'Live' -v ./history

SEARCH_COMPOSE = $(COMPOSE) -f infra/search/compose.yaml
.PHONY: search-up search-down search-test
search-up:
	$(SEARCH_COMPOSE) up -d --wait elasticsearch
search-down:
	$(SEARCH_COMPOSE) stop elasticsearch
search-test: search-up events-up
	python3 -m venv .local/search-venv
	.local/search-venv/bin/pip install -r services/search-indexer/requirements.txt
	SEARCH_KAFKA_LIVE=1 node scripts/search-test.mjs

# Stage 06d: jobs-worker (Go) and notification-service (TypeScript) ledgers.
.PHONY: jobs-migrate
jobs-migrate:
	cd services/jobs-worker && go run ./cmd/migrate
	npm run migrate -w services/notification-service

.PHONY: saga-migrate saga-test
saga-migrate:
	cd services/saga-orchestrator && go run ./cmd/migrate
saga-test:
	cd services/saga-orchestrator && go test -race ./...

# Opt-in RabbitMQ overlay (Stage 06d); never part of dev/verify/smoke.
RABBITMQ_COMPOSE = $(COMPOSE) -f infra/rabbitmq/compose.yaml
RABBITMQ_COMPOSE_ABS = docker compose --env-file $(CURDIR)/.env -f $(CURDIR)/infra/compose/compose.yaml -f $(CURDIR)/infra/rabbitmq/compose.yaml
RABBITMQ_RESTART_CMD ?= $(RABBITMQ_COMPOSE_ABS) restart rabbitmq >/dev/null 2>&1 && $(RABBITMQ_COMPOSE_ABS) up -d --wait rabbitmq >/dev/null 2>&1
.PHONY: rabbitmq-up rabbitmq-down rabbitmq-test dlq-replay redrive-dead
rabbitmq-up:
	$(RABBITMQ_COMPOSE) up -d --wait rabbitmq
rabbitmq-down:
	$(RABBITMQ_COMPOSE) stop rabbitmq
# Destructive: restarts the broker mid-flight and purges the notification queues.
rabbitmq-test: rabbitmq-up jobs-migrate
	cd services/jobs-worker && RABBITMQ_LIVE=1 RABBITMQ_RESTART_CMD='$(RABBITMQ_RESTART_CMD)' go test -count=1 -race -run 'Live' -v .
	npm run live -w services/notification-service
# Task records return to notifications.tasks with the same message id; dispatch-dead
# records are redriven in greenguard_jobs. ARGS="-limit 10"
dlq-replay:
	cd services/jobs-worker && go run . dlq-replay $(ARGS)
# Audited dead -> pending redrive from Postgres. ARGS="-reason 'broker restored' -limit 50 [-tenant UUID]"
redrive-dead:
	cd services/jobs-worker && go run . redrive-dead $(ARGS)
