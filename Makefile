.PHONY: bootstrap db-up db-down db-logs db-migrate dev verify check-plan build smoke
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
	cd services/telemetry-ingest && go run ./cmd/migrate
build:
	npm run build
	mkdir -p build
	cd services/telemetry-ingest && go build -o ../../build/telemetry-ingest .
dev: db-migrate build
	npm run dev
verify: check-plan db-migrate
	npm run format:check
	npm run lint
	npm run typecheck
	npm test
	cd services/telemetry-ingest && test -z "$$(gofmt -l .)"
	cd services/telemetry-ingest && go vet ./...
	cd services/telemetry-ingest && go test -race ./...
	$(MAKE) build
check-plan:
	python3 scripts/check_plan.py
smoke: db-migrate build
	node scripts/smoke.mjs

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
