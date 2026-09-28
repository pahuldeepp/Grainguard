FROM golang@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
WORKDIR /src
COPY packages/go-common packages/go-common
COPY packages/kafka-transport packages/kafka-transport
COPY packages/go-migrations packages/go-migrations
COPY services/hardware-service services/hardware-service
WORKDIR /src/services/hardware-service
RUN CGO_ENABLED=0 go build -trimpath -o /hardware-worker ./cmd/worker

FROM build AS migration-build
RUN CGO_ENABLED=0 go build -trimpath -o /hardware-migrate ./cmd/migrate
FROM scratch AS migration
COPY --from=migration-build /hardware-migrate /hardware-migrate
COPY --from=migration-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
USER 65532:65532
ENTRYPOINT ["/hardware-migrate"]

FROM scratch AS runtime
COPY --from=build /hardware-worker /usr/local/bin/hardware-worker
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/hardware-worker"]
