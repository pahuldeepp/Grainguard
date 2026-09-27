FROM golang@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
WORKDIR /src/services/saga-orchestrator
COPY services/saga-orchestrator/go.* ./
COPY packages/go-common/ /src/packages/go-common/
COPY packages/go-migrations/ /src/packages/go-migrations/
COPY packages/kafka-transport/ /src/packages/kafka-transport/
RUN go mod download
COPY services/saga-orchestrator/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /saga-api ./cmd/api
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /saga-worker ./cmd/worker

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /saga-api /saga-api
COPY --from=build /saga-worker /saga-worker
USER 101:101
EXPOSE 8092
ENTRYPOINT ["/saga-api"]
