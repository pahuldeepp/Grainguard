FROM golang@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
WORKDIR /src
COPY packages/go-common packages/go-common
COPY packages/kafka-transport packages/kafka-transport
COPY packages/go-migrations packages/go-migrations
COPY services/hardware-service services/hardware-service
WORKDIR /src/services/hardware-service
RUN CGO_ENABLED=0 go build -trimpath -o /hardware-worker ./cmd/worker

FROM scratch
COPY --from=build /hardware-worker /usr/local/bin/hardware-worker
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/hardware-worker"]
