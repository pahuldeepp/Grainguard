# Build from repository root.
FROM golang@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
WORKDIR /src
COPY packages/go-common packages/go-common
COPY packages/kafka-transport packages/kafka-transport
COPY services/cassandra-writer services/cassandra-writer
WORKDIR /src/services/cassandra-writer
RUN CGO_ENABLED=0 go build -trimpath -o /cassandra-writer .
RUN CGO_ENABLED=0 go build -trimpath -o /cassandra-migrate ./cmd/migrate

FROM scratch
COPY --from=build /cassandra-writer /usr/local/bin/cassandra-writer
COPY --from=build /cassandra-migrate /usr/local/bin/cassandra-migrate
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
USER 65532:65532
ENV HTTP_ADDR=0.0.0.0:8083
EXPOSE 8083
ENTRYPOINT ["/usr/local/bin/cassandra-writer"]
