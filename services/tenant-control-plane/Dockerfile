# Build from repository root.
FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY packages packages
COPY services/tenant-control-plane services/tenant-control-plane
COPY services/telemetry-ingest/migrations services/telemetry-ingest/migrations
COPY services/projection-builder/migrations services/projection-builder/migrations
COPY services/jobs-worker/migrations services/jobs-worker/migrations
COPY services/saga-orchestrator/migrations services/saga-orchestrator/migrations
COPY services/hardware-service/migrations services/hardware-service/migrations
COPY services/device-service/prisma/migrations services/device-service/prisma/migrations
COPY services/workflow-alerts/prisma/migrations services/workflow-alerts/prisma/migrations
COPY services/risk-engine/migrations services/risk-engine/migrations
COPY services/notification-service/migrations services/notification-service/migrations
COPY scripts/generate-tenant-bootstrap-ledger-manifest.mjs scripts/generate-tenant-bootstrap-ledger-manifest.mjs
RUN npm ci && npm run build --workspace @greenguard/entitlements \
    && npm run build --workspace @greenguard/tenant-control-plane

FROM build AS migration
COPY scripts/verify-migration-url.mjs /app/scripts/verify-migration-url.mjs
USER node
ENTRYPOINT ["sh", "-ec", "node /app/scripts/verify-migration-url.mjs CONTROL_MIGRATION_URL && npm run migrate -w @greenguard/tenant-control-plane"]

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3010
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/services/tenant-control-plane ./services/tenant-control-plane
USER node
EXPOSE 3010
CMD ["node", "services/tenant-control-plane/dist/main.js"]
