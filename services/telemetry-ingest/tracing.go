package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	otelnoop "go.opentelemetry.io/otel/trace/noop"
)

const (
	attrURLPath    = "url.path"
	attrMethod     = "http.request.method"
	attrStatusCode = "http.response.status_code"
	placeholderID  = ":id"
)

// idInPath matches UUIDs and 2+-digit numbers so span names stay low-cardinality.
var idInPath = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9]{2,}`)

// TracingConfig configures InitTracing.
type TracingConfig struct {
	ServiceName  string
	OTLPEndpoint string                // base URL such as http://collector:4318; used when Exporter is nil
	SampleRatio  float64               // root sampling ratio; the caller's decision is kept (ParentBased)
	Exporter     sdktrace.SpanExporter // test override; uses a synchronous processor
}

// Tracing owns the tracer provider.
type Tracing struct {
	Tracer   trace.Tracer
	provider *sdktrace.TracerProvider
}

// InitTracing builds the provider, registers it and the W3C TraceContext propagator globally.
func InitTracing(cfg TracingConfig) (*Tracing, error) {
	opts := []sdktrace.TracerProviderOption{
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(cfg.SampleRatio))),
		sdktrace.WithResource(resource.NewSchemaless(
			attribute.String("service.name", cfg.ServiceName),
			attribute.String("service.version", "0.0.0"),
			attribute.String("deployment.environment.name", "local"),
		)),
	}
	switch {
	case cfg.Exporter != nil:
		opts = append(opts, sdktrace.WithSyncer(cfg.Exporter))
	case cfg.OTLPEndpoint != "":
		u, err := url.Parse(cfg.OTLPEndpoint)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return nil, fmt.Errorf("invalid OTLP endpoint %q", cfg.OTLPEndpoint)
		}
		// Unstarted: the HTTP client needs no Start, and this avoids an unreachable error path.
		// WithEndpointURL posts to the URL path as given, so the traces path is added here.
		exp := otlptracehttp.NewUnstarted(otlptracehttp.WithEndpointURL(u.JoinPath("v1", "traces").String()))
		opts = append(opts, sdktrace.WithBatcher(exp))
	}
	provider := sdktrace.NewTracerProvider(opts...)
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	return &Tracing{Tracer: provider.Tracer(cfg.ServiceName), provider: provider}, nil
}

// Shutdown flushes spans and resets the globals so InitTracing can run again.
func (t *Tracing) Shutdown(ctx context.Context) error {
	err := t.provider.Shutdown(ctx)
	otel.SetTracerProvider(otelnoop.NewTracerProvider())
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator())
	return err
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func spanName(method, path string) string {
	return method + " " + idInPath.ReplaceAllString(path, placeholderID)
}

// Middleware continues the caller's trace (or starts a new root) with one SERVER span per request.
func (t *Tracing) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := t.Tracer.Start(ctx, spanName(r.Method, r.URL.Path),
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(attribute.String(attrMethod, r.Method), attribute.String(attrURLPath, r.URL.Path)))
		defer span.End()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r.WithContext(ctx))
		span.SetAttributes(attribute.Int(attrStatusCode, rec.status))
		if rec.status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, http.StatusText(rec.status))
		}
	})
}

// ActiveTraceparent formats the span in ctx as W3C traceparent with only the sampled flag kept.
func ActiveTraceparent(ctx context.Context) (string, bool) {
	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() {
		return "", false
	}
	flags := "00"
	if sc.IsSampled() {
		flags = "01"
	}
	return fmt.Sprintf("00-%s-%s-%s", sc.TraceID(), sc.SpanID(), flags), true
}
