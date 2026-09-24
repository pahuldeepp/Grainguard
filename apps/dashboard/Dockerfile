FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package*.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY services/device-service/package.json services/device-service/package.json
COPY packages/tenant-auth/package.json packages/tenant-auth/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY apps/dashboard apps/dashboard
RUN npm run build --workspace @greenguard/dashboard
FROM nginxinc/nginx-unprivileged@sha256:04a3275f25d766cff8926d2e57b2ff34a783d6b12a702dc98bb82226d2d9a508
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
