# Build from repository root.
FROM golang@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
WORKDIR /src
COPY packages/go-common packages/go-common
COPY packages/go-migrations packages/go-migrations
COPY packages/kafka-transport packages/kafka-transport
COPY services/jobs-worker services/jobs-worker
WORKDIR /src/services/jobs-worker
RUN CGO_ENABLED=0 go build -trimpath -o /jobs-worker .

FROM build AS migration-build
RUN CGO_ENABLED=0 go build -trimpath -o /jobs-migrate ./cmd/migrate
FROM scratch AS migration
COPY --from=migration-build /jobs-migrate /jobs-migrate
COPY --from=migration-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
USER 65532:65532
ENTRYPOINT ["/jobs-migrate"]

FROM scratch AS runtime
COPY --from=build /jobs-worker /usr/local/bin/jobs-worker
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
USER 65532:65532
ENV JOBS_HTTP_ADDR=0.0.0.0:8095
EXPOSE 8095
ENTRYPOINT ["/usr/local/bin/jobs-worker"]
