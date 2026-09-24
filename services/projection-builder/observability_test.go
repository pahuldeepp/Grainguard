package main

import (
	"context"
	"go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFreshnessMetricsAndTraceParent(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := trace.NewTracerProvider(trace.WithSpanProcessor(recorder))
	defer provider.Shutdown(context.Background())
	p := testProcessor(t)
	p.Tracer = provider.Tracer(consumerName)
	e := validEvent(t)
	if err := p.process(context.Background(), message(e)); err != nil {
		t.Fatal(err)
	}
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Parent().TraceID().String() != strings.Split(e[fieldTrace].(string), "-")[1] {
		t.Fatal("origin context lost")
	}
	p.Observations.observe(-time.Second)
	for _, feedErr := range []error{nil, errTest} {
		a := &app{processor: p, feedAge: func(context.Context) (time.Duration, error) { return time.Minute, feedErr }}
		w := httptest.NewRecorder()
		a.metrics(w, httptest.NewRequest("GET", "/metrics", nil))
		body := w.Body.String()
		if strings.Contains(body, "tenant") || strings.Contains(body, "device") || !strings.Contains(body, "projection_event_to_projection_seconds_count 2") {
			t.Fatal(body)
		}
	}
}
func TestTraceConfiguration(t *testing.T) {
	for _, endpoint := range []string{"%", "relative", "ftp://example.com"} {
		if p, err := initTracing(endpoint); err == nil {
			shutdownTracing(p)
			t.Fatal(endpoint)
		}
	}
	for _, endpoint := range []string{"", "http://127.0.0.1:4318", "https://example.com/otel"} {
		p, err := initTracing(endpoint)
		if err != nil {
			t.Fatal(err)
		}
		shutdownTracing(p)
	}
}
