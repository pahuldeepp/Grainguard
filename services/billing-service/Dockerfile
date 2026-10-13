# Build from repository root.
FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY packages packages
COPY services/billing-service services/billing-service
RUN npm ci && npm run build --workspace @greenguard/membership-client \
    && npm run build --workspace @greenguard/billing-service

FROM build AS migration
COPY scripts/verify-migration-url.mjs /app/scripts/verify-migration-url.mjs
USER node
ENTRYPOINT ["sh", "-ec", "node /app/scripts/verify-migration-url.mjs BILLING_MIGRATION_URL && npm run migrate -w @greenguard/billing-service"]

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
ENV NODE_ENV=production BILLING_HOST=0.0.0.0 BILLING_PORT=3021
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/services/billing-service ./services/billing-service
USER node
EXPOSE 3021
CMD ["node", "services/billing-service/dist/src/main.js"]
