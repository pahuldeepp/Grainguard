FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package*.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY services/device-service/package.json services/device-service/package.json
COPY packages/otel/package.json packages/otel/package.json
COPY packages/tenant-auth/package.json packages/tenant-auth/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/kafka-runtime/package.json packages/kafka-runtime/package.json
COPY packages/entitlements/package.json packages/entitlements/package.json
RUN npm ci
COPY packages packages
COPY services/device-service services/device-service
RUN npm run build --workspace @greenguard/device-service && npm prune --omit=dev
FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/otel ./packages/otel
COPY --from=build --chown=node:node /app/packages/tenant-auth ./packages/tenant-auth
COPY --from=build --chown=node:node /app/packages/contracts ./packages/contracts
COPY --from=build --chown=node:node /app/packages/kafka-runtime ./packages/kafka-runtime
COPY --from=build --chown=node:node /app/packages/entitlements ./packages/entitlements
COPY --from=build --chown=node:node /app/services/device-service ./services/device-service
USER node
EXPOSE 3001
CMD ["node", "services/device-service/dist/main.js"]
