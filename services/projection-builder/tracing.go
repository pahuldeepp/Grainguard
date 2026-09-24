package main

import (
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	common "greenguard.local/go-common"
	"time"
)

func initTracing(endpoint string) (*sdktrace.TracerProvider, error) {
	return common.InitTracing("projection-builder", endpoint)
}
func shutdownTracing(provider *sdktrace.TracerProvider) {
	common.ShutdownTracing(provider, 5*time.Second)
}
