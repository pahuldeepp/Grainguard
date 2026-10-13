package common

import (
	"context"
	"fmt"
	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"log/slog"
	"net/url"
	"os"
	"sync"
	"time"
)

func InitTracing(service, endpoint string) (*sdktrace.TracerProvider, error) {
	options := []sdktrace.TracerProviderOption{
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(0.1))),
		sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", service))),
	}
	if endpoint != "" {
		u, err := url.Parse(endpoint)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return nil, fmt.Errorf("invalid OTLP endpoint")
		}
		if _, err := InitOTelLogging(service, endpoint); err != nil {
			return nil, err
		}
		exporter := otlptracehttp.NewUnstarted(otlptracehttp.WithEndpointURL(u.JoinPath("v1", "traces").String()))
		options = append(options, sdktrace.WithBatcher(exporter))
	}
	return sdktrace.NewTracerProvider(options...), nil
}
func ShutdownTracing(provider *sdktrace.TracerProvider, timeout time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_ = provider.Shutdown(ctx)
	_ = ShutdownOTelLogging(ctx)
}

var loggingState struct {
	sync.Mutex
	provider *sdklog.LoggerProvider
	previous *slog.Logger
}

// InitOTelLogging exports structured slog records over OTLP while retaining local JSON
// stderr output. The OTel bridge records the active span context in each log record.
func InitOTelLogging(service, endpoint string) (*sdklog.LoggerProvider, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("invalid OTLP endpoint")
	}
	exporter, err := otlploghttp.New(context.Background(), otlploghttp.WithEndpointURL(u.JoinPath("v1", "logs").String()))
	if err != nil {
		return nil, fmt.Errorf("create OTLP log exporter: %w", err)
	}
	resource := resource.NewSchemaless(attribute.String("service.name", service))
	provider := sdklog.NewLoggerProvider(sdklog.WithResource(resource), sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)))
	loggingState.Lock()
	defer loggingState.Unlock()
	if loggingState.provider != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = loggingState.provider.Shutdown(ctx)
		cancel()
	}
	loggingState.previous = slog.Default()
	loggingState.provider = provider
	console := slog.NewJSONHandler(os.Stderr, nil)
	remote := otelslog.NewHandler("greenguard.local/go-common", otelslog.WithLoggerProvider(provider))
	slog.SetDefault(slog.New(teeHandler{handlers: []slog.Handler{console, thresholdHandler{handler: remote, min: slog.LevelWarn}}}))
	return provider, nil
}

// ShutdownOTelLogging flushes and closes the process-wide OTLP log provider.
func ShutdownOTelLogging(ctx context.Context) error {
	loggingState.Lock()
	defer loggingState.Unlock()
	if loggingState.provider == nil {
		return nil
	}
	err := loggingState.provider.Shutdown(ctx)
	loggingState.provider = nil
	if loggingState.previous != nil {
		slog.SetDefault(loggingState.previous)
		loggingState.previous = nil
	}
	return err
}

type teeHandler struct{ handlers []slog.Handler }

type thresholdHandler struct {
	handler slog.Handler
	min     slog.Level
}

func (h thresholdHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return level >= h.min && h.handler.Enabled(ctx, level)
}
func (h thresholdHandler) Handle(ctx context.Context, record slog.Record) error {
	if record.Level < h.min {
		return nil
	}
	return h.handler.Handle(ctx, record)
}
func (h thresholdHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return thresholdHandler{handler: h.handler.WithAttrs(attrs), min: h.min}
}
func (h thresholdHandler) WithGroup(name string) slog.Handler {
	return thresholdHandler{handler: h.handler.WithGroup(name), min: h.min}
}

func (h teeHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, handler := range h.handlers {
		if handler.Enabled(ctx, level) {
			return true
		}
	}
	return false
}
func (h teeHandler) Handle(ctx context.Context, record slog.Record) error {
	var first error
	for _, handler := range h.handlers {
		if handler.Enabled(ctx, record.Level) {
			if err := handler.Handle(ctx, record.Clone()); err != nil && first == nil {
				first = err
			}
		}
	}
	return first
}
func (h teeHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	result := make([]slog.Handler, len(h.handlers))
	for i, handler := range h.handlers {
		result[i] = handler.WithAttrs(attrs)
	}
	return teeHandler{handlers: result}
}
func (h teeHandler) WithGroup(name string) slog.Handler {
	result := make([]slog.Handler, len(h.handlers))
	for i, handler := range h.handlers {
		result[i] = handler.WithGroup(name)
	}
	return teeHandler{handlers: result}
}
