package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	otelnoop "go.opentelemetry.io/otel/trace/noop"
	common "greenguard.local/go-common"
)

const (
	attrURLPath          = "url.path"
	attrMethod           = "http.request.method"
	attrStatusCode       = "http.response.status_code"
	placeholderID        = ":id"
	httpErrorLogInterval = 30 * time.Second
)

var httpErrorLogs = newHTTPErrorLogLimiter(httpErrorLogInterval)

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
	logs     bool
}

// InitTracing builds the provider, registers it and the W3C TraceContext propagator globally.
func InitTracing(cfg TracingConfig) (*Tracing, error) {
	var logsEnabled bool
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
		_, err = common.InitOTelLogging(cfg.ServiceName, cfg.OTLPEndpoint)
		if err != nil {
			return nil, err
		}
		logsEnabled = true
		// Unstarted: the HTTP client needs no Start, and this avoids an unreachable error path.
		// WithEndpointURL posts to the URL path as given, so the traces path is added here.
		exp := otlptracehttp.NewUnstarted(otlptracehttp.WithEndpointURL(u.JoinPath("v1", "traces").String()))
		opts = append(opts, sdktrace.WithBatcher(exp))
	}
	provider := sdktrace.NewTracerProvider(opts...)
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	return &Tracing{Tracer: provider.Tracer(cfg.ServiceName), provider: provider, logs: logsEnabled}, nil
}

// Shutdown flushes spans and resets the globals so InitTracing can run again.
func (t *Tracing) Shutdown(ctx context.Context) error {
	err := t.provider.Shutdown(ctx)
	if t.logs {
		if logErr := common.ShutdownOTelLogging(ctx); err == nil {
			err = logErr
		}
	}
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
			route := boundedRoute(r.Method, r.URL.Path)
			if emit, suppressed := httpErrorLogs.allow(time.Now(), route, rec.status); emit {
				slog.ErrorContext(ctx, "http request failed", "method", r.Method, "route", route, "status_code", rec.status, "suppressed_count", suppressed)
			}
		}
		if rec.status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, http.StatusText(rec.status))
		}
	})
}

// boundedRoute avoids putting arbitrary path segments into log fields or limiter keys.
func boundedRoute(method, path string) string {
	parts := strings.Split(path, "/")
	if method == http.MethodPost && len(parts) == 5 && parts[1] == "v1" && parts[2] == "devices" && parts[4] == "readings" {
		return "POST /v1/devices/:id/readings"
	}
	switch path {
	case "/healthz":
		return method + " /healthz"
	case "/readyz":
		return method + " /readyz"
	case "/metrics":
		return method + " /metrics"
	default:
		return method + " /other"
	}
}

type httpErrorLogState struct {
	lastEmitted time.Time
	suppressed  uint64
}

type httpErrorLogLimiter struct {
	mu       sync.Mutex
	interval time.Duration
	states   map[string]httpErrorLogState
}

func newHTTPErrorLogLimiter(interval time.Duration) *httpErrorLogLimiter {
	return &httpErrorLogLimiter{interval: interval, states: make(map[string]httpErrorLogState)}
}

// allow emits once per route/status interval and reports how many repeats were
// suppressed since the previous emitted record.
func (l *httpErrorLogLimiter) allow(now time.Time, route string, status int) (emit bool, suppressed uint64) {
	key := route + "|" + strconv.Itoa(status)
	l.mu.Lock()
	defer l.mu.Unlock()
	state, ok := l.states[key]
	if ok && now.Sub(state.lastEmitted) < l.interval {
		state.suppressed++
		l.states[key] = state
		return false, 0
	}
	suppressed = state.suppressed
	l.states[key] = httpErrorLogState{lastEmitted: now}
	return true, suppressed
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
