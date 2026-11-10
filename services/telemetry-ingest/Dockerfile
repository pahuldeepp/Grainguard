FROM golang@sha256:e519d3b0a5b285e5aa53ab9eef02bc6bbb9cb04608389b743a136a9ce75f0d1e AS build
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
