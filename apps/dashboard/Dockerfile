FROM node@sha256:a98e6fda54fdbb22d4238054cca9a2a113bcd1191c09193a535aae22f400aa8e AS build
WORKDIR /app
COPY package*.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY services/device-service/package.json services/device-service/package.json
COPY packages/otel/package.json packages/otel/package.json
COPY packages/tenant-auth/package.json packages/tenant-auth/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY apps/dashboard apps/dashboard
RUN npm run build --workspace @greenguard/dashboard
FROM nginxinc/nginx-unprivileged@sha256:04a3275f25d766cff8926d2e57b2ff34a783d6b12a702dc98bb82226d2d9a508
# Rendered with envsubst at start; set CSP_CONNECT_EXTRA to the OIDC issuer origin.
ENV CSP_CONNECT_EXTRA=""
COPY apps/dashboard/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
