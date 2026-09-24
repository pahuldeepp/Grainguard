FROM golang@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
WORKDIR /src/services/projection-builder
COPY services/projection-builder/go.* ./
COPY packages/kafka-transport/ /src/packages/kafka-transport/
COPY packages/go-common/ /src/packages/go-common/
COPY packages/go-migrations/ /src/packages/go-migrations/
RUN go mod download
COPY services/projection-builder/*.go ./
COPY services/projection-builder/history/ ./history/
COPY services/projection-builder/cmd/maintain/ ./cmd/maintain/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /projection-builder .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /projection-maintain ./cmd/maintain
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /projection-builder /projection-builder
COPY --from=build /projection-maintain /projection-maintain
COPY contracts/events/ /contracts/events/
USER 65532:65532
ENV HTTP_ADDR=0.0.0.0:8082 EVENT_SCHEMA_DIR=/contracts/events
EXPOSE 8082
ENTRYPOINT ["/projection-builder"]
