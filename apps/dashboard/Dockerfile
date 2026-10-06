FROM node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
# These are public OAuth identifiers/URLs embedded by Vite in the browser bundle.
# Runtime pod env cannot configure a bundle that was already built.
ARG VITE_OIDC_AUTHORITY
ARG VITE_OIDC_CLIENT_ID
ARG VITE_OIDC_AUDIENCE
ARG VITE_OIDC_TOKEN_MODE=audience
ARG VITE_OIDC_RESOURCE
ARG REQUIRE_OIDC_CONFIG=false
ENV VITE_OIDC_AUTHORITY=${VITE_OIDC_AUTHORITY}
ENV VITE_OIDC_CLIENT_ID=${VITE_OIDC_CLIENT_ID}
ENV VITE_OIDC_AUDIENCE=${VITE_OIDC_AUDIENCE}
ENV VITE_OIDC_TOKEN_MODE=${VITE_OIDC_TOKEN_MODE}
ENV VITE_OIDC_RESOURCE=${VITE_OIDC_RESOURCE}
RUN if [ "$REQUIRE_OIDC_CONFIG" = "true" ]; then \
      test -n "$VITE_OIDC_AUTHORITY" && \
      test -n "$VITE_OIDC_CLIENT_ID" && \
      { [ "$VITE_OIDC_TOKEN_MODE" = "cognito-access" ] || \
        { [ "$VITE_OIDC_TOKEN_MODE" = "audience" ] && test -n "$VITE_OIDC_AUDIENCE"; }; }; \
    fi
COPY package*.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY services/bff/package.json services/bff/package.json
COPY services/device-service/package.json services/device-service/package.json
COPY packages/kafka-security/package.json packages/kafka-security/package.json
COPY packages/membership-client/package.json packages/membership-client/package.json
COPY packages/otel/package.json packages/otel/package.json
COPY packages/tenant-auth/package.json packages/tenant-auth/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY packages/kafka-security packages/kafka-security
COPY packages/membership-client packages/membership-client
COPY packages/tenant-auth packages/tenant-auth
COPY services/bff/src/query-policy.ts services/bff/src/query-policy.ts
COPY apps/dashboard apps/dashboard
RUN npm run build -w @greenguard/membership-client \
    && npm run build --workspace @greenguard/dashboard
FROM nginxinc/nginx-unprivileged@sha256:04a3275f25d766cff8926d2e57b2ff34a783d6b12a702dc98bb82226d2d9a508
# Rendered with envsubst at start; set CSP_CONNECT_EXTRA to the OIDC issuer origin.
ENV CSP_CONNECT_EXTRA=""
COPY apps/dashboard/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
