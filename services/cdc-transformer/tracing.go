package main

import (
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	common "greenguard.local/go-common"
)

func initTracing(endpoint string) (*sdktrace.TracerProvider, error) {
	return common.InitTracing("cdc-transformer", endpoint)
}
func shutdownTracing(provider *sdktrace.TracerProvider) {
	common.ShutdownTracing(provider, shutdownTimeout)
}
