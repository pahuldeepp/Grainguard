FROM golang@sha256:205c7636d74e0ffbe3d007162df7d74f859f5a8c8322dfb9f907977686c126cf AS build
WORKDIR /src/services/telemetry-ingest
COPY services/telemetry-ingest/go.* ./
COPY packages/go-migrations/ /src/packages/go-migrations/
COPY packages/go-common/ /src/packages/go-common/
COPY packages/kafka-transport/ /src/packages/kafka-transport/
RUN go mod download
COPY services/telemetry-ingest/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /telemetry-ingest .
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /telemetry-ingest /telemetry-ingest
COPY contracts/events/ /contracts/events/
ENV EVENT_SCHEMA_DIR=/contracts/events
USER 65532:65532
ENV HTTP_ADDR=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/telemetry-ingest"]
