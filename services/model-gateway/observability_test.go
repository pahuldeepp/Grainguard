package modelgateway

import (
	"context"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestCorrelatedProviderTraceAndPrivateMetrics(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := trace.NewTracerProvider(trace.WithSyncer(exporter))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	defer func() { _ = provider.Shutdown(context.Background()); otel.SetTracerProvider(previous) }()
	var downstream string
	server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		downstream = r.Header.Get("traceparent")
		w.Write([]byte(`{"data":[{"index":0,"embedding":[0.1,0.2]}]}`))
	})
	request := httptest.NewRequest("POST", "/v1/embeddings", strings.NewReader(`{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"embed-v1","input":["private prompt"],"input_type":"passage"}`))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("traceparent", "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	spans := exporter.GetSpans()
	if len(spans) != 2 || spans[0].SpanContext.TraceID().String() != "0123456789abcdef0123456789abcdef" || spans[1].SpanContext.TraceID() != spans[0].SpanContext.TraceID() || spans[0].Parent.SpanID() != spans[1].SpanContext.SpanID() {
		t.Fatalf("uncorrelated spans: %+v", spans)
	}
	if !strings.Contains(downstream, spans[0].SpanContext.SpanID().String()) {
		t.Fatal("provider context not injected")
	}
	denial := httptest.NewRecorder()
	server.Handler().ServeHTTP(denial, httptest.NewRequest("POST", "/v1/answers", nil))
	metrics := httptest.NewRecorder()
	server.Handler().ServeHTTP(metrics, httptest.NewRequest("GET", "/metrics", nil))
	body := metrics.Body.String()
	for _, want := range []string{`kind="provider",route="embeddings",outcome="success"`, `kind="request",route="answers",outcome="denied"`} {
		if !strings.Contains(body, want) {
			t.Fatal(body)
		}
	}
	for _, secret := range []string{"private prompt", token, "aaaaaaaa-aaaa", "provider-key", "embed-provider"} {
		if strings.Contains(body, secret) {
			t.Fatal("private metrics")
		}
		for _, span := range exporter.GetSpans() {
			for _, a := range span.Attributes {
				if strings.Contains(a.Value.AsString(), secret) {
					t.Fatal("private trace")
				}
			}
		}
	}
	t.Logf("correlated server/provider spans=%d; denial=401; provider and denial metrics present", len(spans))
}

func TestLocalOTLPCollector(t *testing.T) {
	endpoint := os.Getenv("GREENGUARD_TEST_OTLP_ENDPOINT")
	if endpoint == "" {
		t.Skip("explicit local collector endpoint required")
	}
	previous := otel.GetTracerProvider()
	defer otel.SetTracerProvider(previous)
	shutdown, err := InitTracing(context.Background(), endpoint)
	if err != nil {
		t.Fatal(err)
	}
	server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":[{"index":0,"embedding":[0.1,0.2]}]}`))
	})
	request := httptest.NewRequest("POST", "/v1/embeddings", strings.NewReader(`{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"embed-v1","input":["local collector smoke"],"input_type":"passage"}`))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("traceparent", "00-abcdef0123456789abcdef0123456789-0123456789abcdef-01")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatal(response.Code)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Log("OTLP exported correlated server/provider trace abcdef0123456789abcdef0123456789")
}
