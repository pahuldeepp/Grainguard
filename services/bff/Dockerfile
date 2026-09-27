FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/tenant-auth/package.json packages/tenant-auth/package.json
COPY services/bff/package.json services/bff/package.json
RUN npm ci --ignore-scripts
COPY packages/tenant-auth packages/tenant-auth
COPY services/bff services/bff
RUN npm run build -w @greenguard/bff && npm prune --omit=dev

FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production BFF_PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/tenant-auth ./packages/tenant-auth
COPY --from=build --chown=node:node /app/services/bff ./services/bff
USER node
EXPOSE 4000
CMD ["node", "services/bff/dist/main.js"]
