# Build from repository root; contacts projector uses Dockerfile.contacts-projector.
FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package*.json ./
COPY packages packages
COPY services/notification-service services/notification-service
RUN npm ci && npm run build --workspace @greenguard/membership-client \
    && npm run build --workspace @greenguard/feature-flags \
    && npm run build --workspace @greenguard/otel \
    && npm run build --workspace @greenguard/notification-service

FROM build AS migration
COPY scripts/verify-migration-url.mjs /app/scripts/verify-migration-url.mjs
USER node
ENTRYPOINT ["sh", "-ec", "node /app/scripts/verify-migration-url.mjs NOTIFICATIONS_MIGRATION_URL && node /app/services/notification-service/dist/migrate.js"]

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
ENV NODE_ENV=production NOTIFICATIONS_HTTP_HOST=0.0.0.0 NOTIFICATIONS_HTTP_PORT=8096
WORKDIR /app
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/services/notification-service ./services/notification-service
USER node
EXPOSE 8096
CMD ["node", "services/notification-service/dist/main.js"]
