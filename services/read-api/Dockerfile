FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/tenant-auth/package.json packages/tenant-auth/package.json
COPY packages/read-model/package.json packages/read-model/package.json
COPY services/read-api/package.json services/read-api/package.json
RUN npm ci --ignore-scripts
COPY packages/tenant-auth packages/tenant-auth
COPY packages/read-model packages/read-model
COPY services/read-api services/read-api
RUN npm run build -w @greenguard/read-api && npm prune --omit=dev

FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production READ_API_PORT=4001
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/tenant-auth ./packages/tenant-auth
COPY --from=build --chown=node:node /app/packages/read-model ./packages/read-model
COPY --from=build --chown=node:node /app/services/read-api ./services/read-api
USER node
EXPOSE 4001
CMD ["node", "services/read-api/dist/main.js"]
