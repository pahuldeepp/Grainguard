FROM golang:1.27.1-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195 AS build
WORKDIR /src
COPY services/model-gateway/go.mod services/model-gateway/go.sum ./
RUN go mod download
COPY services/model-gateway/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/model-gateway ./cmd/model-gateway \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/model-gateway-migrate ./cmd/model-gateway-migrate \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/model-gateway-budget-bootstrap ./cmd/model-gateway-budget-bootstrap

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/model-gateway /model-gateway
COPY --from=build /out/model-gateway-migrate /model-gateway-migrate
COPY --from=build /out/model-gateway-budget-bootstrap /model-gateway-budget-bootstrap
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/model-gateway"]
