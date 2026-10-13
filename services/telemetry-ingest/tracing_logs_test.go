package main

import (
	"bytes"
	"context"
	"encoding/hex"
	collectorlogs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	"google.golang.org/protobuf/proto"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestServerFailureExportsTraceCorrelatedOTLPLog(t *testing.T) {
	logs := make(chan []byte, 1)
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path == "/v1/logs" {
			logs <- body
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer collector.Close()

	tracing, err := InitTracing(TracingConfig{ServiceName: "telemetry-ingest-test", OTLPEndpoint: collector.URL, SampleRatio: 1})
	if err != nil {
		t.Fatal(err)
	}
	handler := tracing.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) }))
	req := httptest.NewRequest(http.MethodPost, "/v1/devices/123e4567-e89b-12d3-a456-426614174000/readings", nil)
	req.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", response.Code)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second*5)
	defer cancel()
	if err := tracing.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	select {
	case payload := <-logs:
		var exported collectorlogs.ExportLogsServiceRequest
		if err := proto.Unmarshal(payload, &exported); err != nil {
			t.Fatalf("decode OTLP log export: %v", err)
		}
		wantTraceID, _ := hex.DecodeString("4bf92f3577b34da6a3ce929d0e0e4736")
		for _, resource := range exported.ResourceLogs {
			for _, scope := range resource.ScopeLogs {
				for _, record := range scope.LogRecords {
					if !bytes.Equal(record.TraceId, wantTraceID) {
						continue
					}
					if string(record.Body.GetStringValue()) != "http request failed" {
						t.Fatalf("OTLP log body = %q", record.Body.GetStringValue())
					}
					if !bytes.Contains(payload, []byte("POST /v1/devices/:id/readings")) {
						t.Fatal("OTLP log missing bounded route attribute")
					}
					return
				}
			}
		}
		t.Fatal("OTLP log did not contain the extracted trace id")
	case <-ctx.Done():
		t.Fatal("OTLP log was not exported before shutdown")
	}
}

func TestHTTPErrorLogLimiterSummarizesRepeatedFaults(t *testing.T) {
	limiter := newHTTPErrorLogLimiter(30 * time.Second)
	start := time.Unix(100, 0)
	if emit, count := limiter.allow(start, "POST /v1/devices/:id/readings", http.StatusServiceUnavailable); !emit || count != 0 {
		t.Fatalf("first fault: emit=%v suppressed=%d", emit, count)
	}
	for i := 0; i < 150; i++ {
		if emit, _ := limiter.allow(start.Add(time.Duration(i+1)*time.Millisecond), "POST /v1/devices/:id/readings", http.StatusServiceUnavailable); emit {
			t.Fatalf("duplicate %d unexpectedly emitted", i)
		}
	}
	if emit, _ := limiter.allow(start.Add(29*time.Second), "POST /v1/devices/:id/readings", http.StatusServiceUnavailable); emit {
		t.Fatal("fault inside interval unexpectedly emitted")
	}
	if emit, count := limiter.allow(start.Add(30*time.Second), "POST /v1/devices/:id/readings", http.StatusServiceUnavailable); !emit || count != 151 {
		t.Fatalf("interval summary: emit=%v suppressed=%d, want true and 151", emit, count)
	}
}

func TestBoundedRouteDoesNotRetainArbitraryPathSegments(t *testing.T) {
	if route := boundedRoute(http.MethodPost, "/v1/devices/customer-secret/readings"); route != "POST /v1/devices/:id/readings" {
		t.Fatalf("route = %q", route)
	}
	if route := boundedRoute(http.MethodGet, "/arbitrary/customer-secret/path"); route != "GET /other" {
		t.Fatalf("route = %q", route)
	}
}
