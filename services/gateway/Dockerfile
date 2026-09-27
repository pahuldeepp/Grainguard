FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/tenant-auth/package.json packages/tenant-auth/package.json
COPY packages/membership-client/package.json packages/membership-client/package.json
COPY services/gateway/package.json services/gateway/package.json
RUN npm ci --ignore-scripts
COPY packages/tenant-auth packages/tenant-auth
COPY packages/membership-client packages/membership-client
COPY services/gateway services/gateway
RUN npm run build -w services/gateway

FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=4002
WORKDIR /app
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/tenant-auth /app/packages/tenant-auth
COPY --from=build /app/packages/membership-client /app/packages/membership-client
COPY --from=build /app/services/gateway /app/services/gateway
USER node
EXPOSE 4002
CMD ["node", "services/gateway/dist/main.js"]
