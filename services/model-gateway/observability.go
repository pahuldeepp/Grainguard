package modelgateway

import (
	"context"
	"fmt"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// Labels are closed sets; request content, credentials and identities never enter metrics.
var latencyBounds = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120}

type gatewayMetrics struct {
	mu      sync.Mutex
	count   map[string]int
	seconds map[string]float64
	buckets map[string][]int
}

func (m *gatewayMetrics) observe(kind, route, outcome string, elapsed time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.count == nil {
		m.count = map[string]int{}
		m.seconds = map[string]float64{}
		m.buckets = map[string][]int{}
	}
	key := fmt.Sprintf(`kind="%s",route="%s",outcome="%s"`, kind, route, outcome)
	m.count[key]++
	m.seconds[key] += elapsed.Seconds()
	if m.buckets[key] == nil {
		m.buckets[key] = make([]int, len(latencyBounds))
	}
	for i, bound := range latencyBounds {
		if elapsed.Seconds() <= bound {
			m.buckets[key][i]++
		}
	}
}
func (m *gatewayMetrics) render(w http.ResponseWriter) {
	m.mu.Lock()
	defer m.mu.Unlock()
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	fmt.Fprintln(w, "# TYPE greenguard_model_gateway_operations_total counter\n# TYPE greenguard_model_gateway_operation_seconds histogram")
	for key, count := range m.count {
		for i, bound := range latencyBounds {
			fmt.Fprintf(w, "greenguard_model_gateway_operation_seconds_bucket{%s,le=\"%g\"} %d\n", key, bound, m.buckets[key][i])
		}
		fmt.Fprintf(w, "greenguard_model_gateway_operation_seconds_bucket{%s,le=\"+Inf\"} %d\n", key, count)
		fmt.Fprintf(w, "greenguard_model_gateway_operations_total{%s} %d\ngreenguard_model_gateway_operation_seconds_sum{%s} %g\ngreenguard_model_gateway_operation_seconds_count{%s} %d\n", key, count, key, m.seconds[key], key, count)
	}
}

type observedResponse struct {
	http.ResponseWriter
	status int
}

func (w *observedResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *observedResponse) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(body)
}
func outcome(status int) string {
	if status == 401 || status == 403 {
		return "denied"
	}
	if status == 429 {
		return "limited"
	}
	if status >= 500 || status == 0 {
		return "failure"
	}
	if status >= 400 {
		return "invalid"
	}
	return "success"
}
func boundedRoute(path string) string {
	switch path {
	case "/v1/embeddings":
		return "embeddings"
	case "/v1/rerank":
		return "rerank"
	case "/v1/answers":
		return "answers"
	case "/v1/structured/plan":
		return "structured_plan"
	case "/v1/agent/plan":
		return "agent_plan"
	case "/v1/agent/respond":
		return "agent_respond"
	default:
		return "other"
	}
}

func (s *Server) observeHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/metrics" {
			s.metrics.render(w)
			return
		}
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			next.ServeHTTP(w, r)
			return
		}
		ctx := propagation.TraceContext{}.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := otel.Tracer("model-gateway").Start(ctx, "gateway."+boundedRoute(r.URL.Path), trace.WithSpanKind(trace.SpanKindServer))
		defer span.End()
		r = r.WithContext(ctx)
		start := time.Now()
		response := &observedResponse{ResponseWriter: w}
		next.ServeHTTP(response, r)
		span.SetAttributes(attribute.Int("http.response.status_code", response.status))
		s.metrics.observe("request", boundedRoute(r.URL.Path), outcome(response.status), time.Since(start))
	})
}
func boundedProviderRoute(path string) string {
	switch path {
	case "/embeddings":
		return "embeddings"
	case "/rerank":
		return "rerank"
	case "/messages", "/chat/completions":
		return "answer"
	default:
		return "other"
	}
}

func InitTracing(ctx context.Context, endpoint string) (func(context.Context) error, error) {
	if endpoint == "" {
		return func(context.Context) error { return nil }, nil
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("invalid OTLP endpoint")
	}
	exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(u.JoinPath("v1", "traces").String()))
	if err != nil {
		return nil, err
	}
	provider := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter), sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", "model-gateway"))), sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(1))))
	otel.SetTracerProvider(provider)
	return provider.Shutdown, nil
}
