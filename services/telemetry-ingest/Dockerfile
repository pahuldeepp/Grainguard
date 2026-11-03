FROM golang@sha256:2920bb124f1a2e12a1d39f0cab756ae0068441ee1da7655dec7f5e374944095b AS build
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
