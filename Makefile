.PHONY: bootstrap db-up db-down db-logs db-migrate build-otel dev verify check-plan build smoke helm-validate kyverno-validate observability-up observability-down observability-validate observability-test-rules ml-clickhouse-up ml-clickhouse-down ml-local-synthetic-seed
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
db-migrate: db-up build-otel
	npm run migrate -w services/device-service
	npm run migrate -w services/workflow-alerts
	npm run migrate -w services/tenant-control-plane
	npm run migrate -w @greenguard/billing-service
	cd services/telemetry-ingest && go run ./cmd/migrate
	$(MAKE) projection-migrate
	$(MAKE) risk-migrate
	npm run migrate -w @greenguard/notification-service
	$(MAKE) jobs-migrate
	$(MAKE) saga-migrate
	$(MAKE) hardware-migrate
build-otel:
	npm run build -w @greenguard/otel
build:
	npm run build
	mkdir -p build
	cd services/telemetry-ingest && go build -o ../../build/telemetry-ingest .
	cd services/cdc-transformer && go build -o ../../build/cdc-transformer .
	cd services/cache-invalidator && go build -o ../../build/cache-invalidator .
	cd services/projection-builder && go build -o ../../build/projection-builder .
	cd services/hardware-service && go build -o ../../build/hardware-worker ./cmd/worker
dev: db-migrate build
	npm run dev
verify: check-plan db-migrate
	$(MAKE) control-plane-seed
	$(MAKE) risk-test
	npm run format:check
	npm run lint
	npm run typecheck
	npm test
	node --test scripts/contacts-schema.test.mjs
	node --test scripts/placement-fixture.test.mjs
	node --test scripts/stage12-compose-gate.test.mjs tests/chaos/stage13-harness.test.mjs
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
	cd services/cache-invalidator && test -z "$$(gofmt -l .)"
	cd services/cache-invalidator && go vet ./...
	cd services/cache-invalidator && go test -race ./...
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
	cd services/hardware-service && test -z "$$(gofmt -l .)"
	cd services/hardware-service && go vet ./...
	cd services/hardware-service && go test -race ./...
	$(MAKE) build
check-plan:
	python3 scripts/check_plan.py
helm-validate:
	bash scripts/helm-validate.sh
kyverno-validate:
	bash scripts/kyverno-validate.sh
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
.PHONY: cassandra-up cassandra-down cassandra-test cassandra-rf3-test
cassandra-up:
	$(CASSANDRA_COMPOSE) up -d --wait cassandra
	cd services/cassandra-writer && go run ./cmd/migrate
cassandra-down:
	$(CASSANDRA_COMPOSE) stop cassandra
cassandra-test:
	cd services/cassandra-writer && CASSANDRA_HOSTS=$(CASSANDRA_HOSTS) CASSANDRA_LIVE=1 go test -count=1 -race -run 'Live' -v ./...

# Isolated, disposable RF3 cluster acceptance. Uses ports 59043-59045 and
# separate persistent volumes; the script stops (but does not delete) the lab.
cassandra-rf3-test:
	bash scripts/cassandra-rf3-acceptance.sh

.PHONY: telemetry-source-retention-guard
telemetry-source-retention-guard:
	bash scripts/check-write-side-retention-guard.sh

# Destructive, opt-in local fault gate: stops/starts ONLY the Cassandra container
# (startup-while-down and a CASSANDRA_OUTAGE_SECONDS outage, default 130).
.PHONY: history-test
history-test:
	cd services/cassandra-writer && KAFKA_BROKERS=127.0.0.1:59092 CASSANDRA_HOSTS=$(CASSANDRA_HOSTS) CASSANDRA_LIVE=1 KAFKA_CASSANDRA_LIVE=1 KAFKA_CASSANDRA_FAULT_LIVE=1 KAFKA_CASSANDRA_RESILIENCE_LIVE=1 go test -count=1 -race -timeout 20m -run 'Live' -v .
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

SEARCH_OPENSEARCH_COMPOSE = $(COMPOSE) -f infra/search/opensearch.compose.yaml
.PHONY: search-opensearch-up search-opensearch-down search-opensearch-test
search-opensearch-up:
	$(SEARCH_OPENSEARCH_COMPOSE) up -d --wait opensearch
search-opensearch-down:
	$(SEARCH_OPENSEARCH_COMPOSE) stop opensearch
search-opensearch-test: search-opensearch-up
	python3 -m venv .local/search-venv
	.local/search-venv/bin/pip install -r services/search-indexer/requirements.txt
	python3 -m unittest discover -s services/search-indexer -v
	ELASTICSEARCH_URL=http://127.0.0.1:29200 .local/search-venv/bin/python services/search-indexer/live_test.py

DYNAMODB_COMPOSE = $(COMPOSE) -f infra/dynamodb/compose.yaml
.PHONY: dynamodb-up dynamodb-down stage10b-dynamodb-test stage10b-kafka-test
dynamodb-up:
	$(DYNAMODB_COMPOSE) up -d dynamodb-local
dynamodb-down:
	$(DYNAMODB_COMPOSE) stop dynamodb-local
stage10b-dynamodb-test: dynamodb-up
	DYNAMODB_LIVE=1 DYNAMODB_ENDPOINT=http://127.0.0.1:28000 npm test -w @greenguard/feature-flags
stage10b-kafka-test: dynamodb-up events-up
	node scripts/kafka-topics.mjs
	npm run build -w services/notification-service
	STAGE10B_KAFKA_LIVE=1 DYNAMODB_ENDPOINT=http://127.0.0.1:28000 KAFKA_BROKERS=127.0.0.1:59092 node --test services/notification-service/dist/dynamodb-flag-feed.live.test.js

CDK_VENV = .local/cdk-venv
.PHONY: cdk-install cdk-test cdk-synth serverless-bridge-test stage10b-serverless-test
cdk-install:
	python3 -m venv $(CDK_VENV)
	$(CDK_VENV)/bin/pip install -r infra/cdk/requirements.txt
cdk-test: cdk-install
	cd infra/cdk && ../../$(CDK_VENV)/bin/python -m unittest discover -s . -p 'test_*.py' -v
cdk-synth: cdk-install
	cd infra/cdk && ../../$(CDK_VENV)/bin/python app.py -c environment=dev
serverless-bridge-test: cdk-install
	$(CDK_VENV)/bin/pip install -r services/eventbridge-bridge/requirements.txt
	PYTHONPATH=services/eventbridge-bridge $(CDK_VENV)/bin/python -m unittest discover -s services/eventbridge-bridge -p 'test_*.py' -v
stage10b-serverless-test: cdk-test serverless-bridge-test

# Stage 06d: jobs-worker (Go) and notification-service (TypeScript) ledgers.
.PHONY: jobs-migrate
jobs-migrate:
	cd services/jobs-worker && go run ./cmd/migrate
	npm run migrate -w services/notification-service

# Stage 10d opt-in local live proof. Uses a one-run Kafka topic and never
# publishes synthetic alert events to the canonical lifecycle topic.
.PHONY: stage10d-routing-live-test
stage10d-routing-live-test: db-up jobs-migrate
	$(EVENTS_COMPOSE) up -d --wait kafka
	@set -eu; . ./.env; topic="greenguard-test-stage10d-$$(date +%s)-$$$$"; \
	  $(EVENTS_COMPOSE) exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:29092 --create --topic "$$topic" --partitions 1 --replication-factor 1; \
	  cleanup() { $(EVENTS_COMPOSE) exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:29092 --delete --topic "$$topic" >/dev/null 2>&1 || true; }; \
	  trap cleanup EXIT INT TERM; \
	  cd services/jobs-worker; \
	  JOBS_KAFKA_LIVE=1 KAFKA_BROKERS=127.0.0.1:59092 ALERTS_LIFECYCLE_TOPIC="$$topic" go test -count=1 -run TestKafkaAlertIntakeLive -v .

.PHONY: saga-migrate saga-test
saga-migrate:
	cd services/saga-orchestrator && go run ./cmd/migrate
saga-test:
	cd services/saga-orchestrator && go test -race ./...

.PHONY: inventory-saga-test
inventory-saga-test:
	npm run build -w @greenguard/device-service
	node --test services/device-service/dist/saga/inventory.live.test.js

.PHONY: device-test
device-test:
	npm test -w @greenguard/device-service

.PHONY: inventory-saga-kafka-test
inventory-saga-kafka-test:
	npm run build -w @greenguard/device-service
	INVENTORY_SAGA_KAFKA_LIVE=1 KAFKA_BROKERS=127.0.0.1:59092 node --test services/device-service/dist/saga/kafka.live.test.js

.PHONY: stage07-e2e
stage07-e2e: events-up
	$(EVENTS_COMPOSE) up -d --wait mosquitto
	npm run build -w @greenguard/device-service
	node scripts/stage07-e2e.mjs

.PHONY: hardware-migrate hardware-test
hardware-migrate:
	cd services/hardware-service && go run ./cmd/migrate
hardware-test:
	cd services/hardware-service && go test -race ./...
.PHONY: hardware-mqtt-test
hardware-mqtt-test:
	cd services/hardware-service && MQTT_TEST_BROKER_URL=tcp://127.0.0.1:51883 go test -count=1 -race -run TestLiveMQTTConfigureAckReplay -v ./hardware

.PHONY: hardware-kafka-test
hardware-kafka-test:
	cd services/hardware-service && HARDWARE_KAFKA_LIVE=1 KAFKA_BROKERS=127.0.0.1:59092 go test -count=1 -race -run TestLiveKafkaHardwareCommandResultAndReplay -v ./hardware

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
	npm run live:rabbit -w services/notification-service
# Task records return to notifications.tasks with the same message id; dispatch-dead
# records are redriven in greenguard_jobs. ARGS="-limit 10"
dlq-replay:
	cd services/jobs-worker && go run . dlq-replay $(ARGS)
# Audited dead -> pending redrive from Postgres. ARGS="-reason 'broker restored' -limit 50 [-tenant UUID]"
redrive-dead:
	cd services/jobs-worker && go run . redrive-dead $(ARGS)

# Opt-in Stage 08 OIDC proof (ADR-0014); never part of verify.
.PHONY: oidc-up oidc-down oidc-test oidc-browser-test
oidc-up:
	docker compose --env-file .env -f infra/oidc/compose.yaml up -d --wait
oidc-down:
	docker compose --env-file .env -f infra/oidc/compose.yaml down
oidc-test: oidc-up
	npm run build -w @greenguard/tenant-auth -w @greenguard/bff -w @greenguard/read-api
	set -a; . ./.env; set +a; node scripts/oidc-live.mjs

# Opt-in Redis Cluster for the Read API cache (ADR-0015); never part of verify.
REDIS_COMPOSE = docker compose -f infra/redis/compose.yaml
.PHONY: cache-invalidator-up cache-invalidator-down cache-invalidator-test
cache-invalidator-up:
	docker compose -f infra/cache-invalidator/compose.yaml up -d --build
cache-invalidator-down:
	docker compose -f infra/cache-invalidator/compose.yaml down
cache-invalidator-test:
	cd services/cache-invalidator && go test -race ./...
.PHONY: redis-up redis-down redis-test redis-load
redis-up:
	$(REDIS_COMPOSE) up -d --wait redis-node-1 redis-node-2 redis-node-3 redis-node-4 redis-node-5 redis-node-6
	$(REDIS_COMPOSE) up redis-cluster-init
redis-down:
	$(REDIS_COMPOSE) down
redis-test: redis-up
	npm run build -w @greenguard/read-api
	node scripts/redis-test.mjs
redis-load: redis-up
	npm run build -w @greenguard/read-api
	node scripts/redis-load.mjs
oidc-browser-test: oidc-up
	npm run build -w @greenguard/tenant-auth -w @greenguard/bff -w @greenguard/read-api
	set -a; . ./.env; set +a; node scripts/oidc-browser.mjs

# Opt-in full Stage 08 browser gate. Uses the already-running local event,
# database, Redis Cluster, and OIDC containers without restarting them.
.PHONY: browser-e2e
browser-e2e:
	npm run build -w @greenguard/device-service -w @greenguard/read-api -w @greenguard/workflow-alerts -w @greenguard/bff -w @greenguard/gateway
	VITE_OIDC_AUTHORITY=http://127.0.0.1:5556/dex VITE_OIDC_CLIENT_ID=greenguard-dashboard VITE_OIDC_AUDIENCE=greenguard-dashboard npm run build -w @greenguard/dashboard
	node scripts/browser-e2e.mjs

# Stage 09a: migrate infra/oidc/memberships.json into greenguard_control (idempotent).
control-plane-seed:
	npm run build -w @greenguard/tenant-control-plane
	npm run seed -w @greenguard/tenant-control-plane
control-plane-test:
	npm test -w @greenguard/membership-client
	npm test -w @greenguard/tenant-control-plane

# Real local control-plane/Postgres + gateway/BFF/Read API machine-auth path.
.PHONY: stage09b-machine-e2e
stage09b-machine-e2e:
	node --env-file=.env scripts/stage09b-machine-e2e.mjs

.PHONY: billing-e2e
billing-e2e:
	set -a; . ./.env; set +a; npm run test -w @greenguard/billing-service

# Starts the Stage 09f control plane and notification worker against live Kafka/RabbitMQ.
.PHONY: stage09f-notifications-live
stage09f-notifications-live:
	bash scripts/stage09f-notifications-live.sh

.PHONY: stage09f-e2e
stage09f-e2e:
	node scripts/stage09f-flags-e2e.mjs

# Durable Stage 09e export worker (requires audit key material and owner DB URLs in .env).
.PHONY: audit-export-worker
audit-export-worker:
	node --env-file=.env services/tenant-control-plane/dist/audit/worker.js

# Opt-in local S3-compatible store for Stage 09e audit exports (MinIO); never part of dev/verify/smoke.
OBJECTSTORE_COMPOSE = $(COMPOSE) -f infra/objectstore/compose.yaml
.PHONY: objectstore-up objectstore-down audit-s3-test
objectstore-up:
	$(OBJECTSTORE_COMPOSE) up -d minio
	node --env-file=.env infra/objectstore/init-bucket.mjs
objectstore-down:
	$(OBJECTSTORE_COMPOSE) stop minio
audit-s3-test: objectstore-up
	npm run build -w @greenguard/tenant-control-plane
	cd services/tenant-control-plane && AUDIT_S3_LIVE=1 node --env-file=../../.env --test --test-concurrency=1 dist/audit/audit-s3.live.test.js

# Opt-in Stage 10c partner MySQL snapshot/binlog profile. Credentials live only
# in .local; the base dev/verify targets never load this overlay.
MYSQL_CDC_COMPOSE = docker compose --env-file .env --env-file .local/mysql-cdc.env -f infra/compose/compose.yaml -f infra/kafka/compose.yaml -f infra/mysql-cdc/compose.yaml
.PHONY: mysql-cdc-test
mysql-cdc-test: db-migrate
	python3 labs/mysql-cdc/prepare_local.py
	$(MYSQL_CDC_COMPOSE) up -d --wait mysql-cdc kafka schema-registry connect
	python3 -m venv .local/mysql-cdc-venv
	.local/mysql-cdc-venv/bin/python -m pip install -q -r labs/mysql-cdc/requirements.txt
	npm run build -w services/device-service
	.local/mysql-cdc-venv/bin/python labs/mysql-cdc/setup_local.py
	.local/mysql-cdc-venv/bin/python -m unittest discover -s labs/mysql-cdc -p 'test_*.py' -v
	.local/mysql-cdc-venv/bin/python labs/mysql-cdc/live_test.py

# Design-system conformance (docs/DESIGN_SYSTEM.md); add ARGS=--strict to fail on missing files.
.PHONY: design-check
design-check:
	node --test scripts/design-check.test.mjs
	node scripts/design-check.mjs --report=evidence/design-check-latest.md $(ARGS)

.PHONY: observability-test-ml-rules
observability-test-ml-rules:
	docker run --rm --entrypoint promtool -v "$(CURDIR)/infra/observability:/etc/prometheus:ro" prom/prometheus:v3.2.1 check rules /etc/prometheus/rules/ml-scoring.yaml
	docker run --rm --entrypoint promtool -v "$(CURDIR)/infra/observability:/etc/prometheus:ro" prom/prometheus:v3.2.1 test rules /etc/prometheus/tests/ml-scoring.test.yaml

# Optional local-only ClickHouse analytics plus canonical synthetic scorer fixtures.
ml-clickhouse-up:
	docker compose -f labs/clickhouse/compose.yaml up -d --wait clickhouse
	docker compose -f labs/clickhouse/compose.yaml --profile init run --rm schema-init
ml-clickhouse-down:
	docker compose -f labs/clickhouse/compose.yaml down
ml-local-synthetic-seed:
	ML_SYNTHETIC_TENANT_ID=0a0a0a0a-0000-4000-8000-00000000000a PYTHONPATH=services/ml-scoring .local/ml-scoring-venv/bin/python services/ml-scoring/seed_local_synthetic.py --allow-local-synthetic
.PHONY: telemetry-pipeline-e2e
telemetry-pipeline-e2e:
	@set -eu; compose='docker compose -f labs/telemetry-pipeline/compose.yaml'; \
	cleanup() { $$compose down --volumes --remove-orphans >/dev/null 2>&1 || true; }; \
	trap cleanup EXIT INT TERM; \
	$$compose up -d --build --wait kafka clickhouse minio minio-init telemetry-archive telemetry-clickhouse-sink; \
	$$compose run --rm publisher; \
	$$compose run --rm acceptance; \
	$$compose run --rm --entrypoint python telemetry-archive -m telemetry_sinks.replay --prefix telemetry/greenguard.telemetry.recorded.v1/ --topic greenguard.telemetry.recorded.v1 --confirm; \
	replay_check=$$($$compose run -T --rm --entrypoint python telemetry-archive -m telemetry_sinks.replay --prefix telemetry/greenguard.telemetry.recorded.v1/ --topic greenguard.telemetry.recorded.v1); \
	printf '%s\n' "$$replay_check"; \
	python3 -c 'import json,sys; result=json.loads(sys.argv[1]); assert result["objects"] == 1 and result["mode"].startswith("dry-run"), result' "$$replay_check"; \
	$$compose run --rm -e EXPECTED_ARCHIVE_OBJECTS=2 acceptance
