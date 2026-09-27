FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/otel/package.json packages/otel/package.json
COPY packages/tenant-auth/package.json packages/tenant-auth/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/workflow-alerts/package.json services/workflow-alerts/package.json
RUN npm ci
COPY packages/otel packages/otel
COPY packages/tenant-auth packages/tenant-auth
COPY packages/contracts packages/contracts
COPY services/workflow-alerts services/workflow-alerts
RUN npm run build -w @greenguard/workflow-alerts && npm prune --omit=dev

FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3004
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/otel ./packages/otel
COPY --from=build --chown=node:node /app/packages/tenant-auth ./packages/tenant-auth
COPY --from=build --chown=node:node /app/packages/contracts ./packages/contracts
COPY --chown=node:node contracts/events ./contracts/events
COPY --from=build --chown=node:node /app/services/workflow-alerts ./services/workflow-alerts
USER node
EXPOSE 3004
CMD ["node", "services/workflow-alerts/dist/main.js"]
