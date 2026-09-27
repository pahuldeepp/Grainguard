FROM golang@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
WORKDIR /src/services/cache-invalidator
COPY services/cache-invalidator/go.* ./
COPY packages/kafka-transport/ /src/packages/kafka-transport/
COPY packages/go-common/ /src/packages/go-common/
RUN go mod download
COPY services/cache-invalidator/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /cache-invalidator .

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /cache-invalidator /cache-invalidator
USER 65532:65532
ENV HTTP_ADDR=0.0.0.0:8091
EXPOSE 8091
ENTRYPOINT ["/cache-invalidator"]
