package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

const (
	obsTraceID = "0af7651916cd43dd8448eb211c80319c"
	obsSpanID  = "b7ad6b7169203331"
)

func obsInit(t *testing.T, ratio float64) (*Tracing, *tracetest.InMemoryExporter) {
	t.Helper()
	exp := tracetest.NewInMemoryExporter()
	tr, err := InitTracing(TracingConfig{ServiceName: "svc", SampleRatio: ratio, Exporter: exp})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tr.Shutdown(context.Background()) })
	return tr, exp
}

func obsServe(tr *Tracing, method, path, traceparent string, status int) {
	h := tr.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if status != 0 {
			w.WriteHeader(status)
		}
	}))
	req := httptest.NewRequest(method, path, nil)
	if traceparent != "" {
		req.Header.Set("traceparent", traceparent)
	}
	h.ServeHTTP(httptest.NewRecorder(), req)
}

func obsAttr(s tracetest.SpanStub, key string) string {
	for _, kv := range s.Attributes {
		if string(kv.Key) == key {
			return kv.Value.Emit()
		}
	}
	return ""
}

func TestTraceContinuation(t *testing.T) {
	tr, exp := obsInit(t, 0)
	obsServe(tr, http.MethodPost, "/v1/readings", "00-"+obsTraceID+"-"+obsSpanID+"-01", 0)
	spans := exp.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("spans = %d", len(spans))
	}
	s := spans[0]
	if s.SpanContext.TraceID().String() != obsTraceID || s.Parent.SpanID().String() != obsSpanID ||
		s.SpanContext.SpanID().String() == obsSpanID {
		t.Fatalf("not continued: %+v", s)
	}
	if s.SpanKind != trace.SpanKindServer || s.Name != "POST /v1/readings" {
		t.Fatalf("kind/name: %v %q", s.SpanKind, s.Name)
	}
	if obsAttr(s, "http.response.status_code") != "200" || obsAttr(s, "url.path") != "/v1/readings" ||
		obsAttr(s, "http.request.method") != "POST" {
		t.Fatalf("attrs: %v", s.Attributes)
	}
	if s.Status.Code == codes.Error {
		t.Fatal("unexpected error status")
	}
	res := map[string]string{}
	for _, kv := range s.Resource.Attributes() {
		res[string(kv.Key)] = kv.Value.Emit()
	}
	if res["service.name"] != "svc" || res["service.version"] != "0.0.0" || res["deployment.environment.name"] != "local" {
		t.Fatalf("resource: %v", res)
	}
}

func TestRootOnBadTraceparent(t *testing.T) {
	bad := []string{"", "garbage", "00-" + strings.Repeat("0", 32) + "-" + obsSpanID + "-01",
		"00-" + obsTraceID + "-" + strings.Repeat("0", 16) + "-01"}
	for _, tp := range bad {
		tr, exp := obsInit(t, 1)
		obsServe(tr, http.MethodGet, "/x", tp, 0)
		s := exp.GetSpans()[0]
		if s.Parent.IsValid() || !s.SpanContext.TraceID().IsValid() || s.SpanContext.TraceID().String() == obsTraceID {
			t.Fatalf("expected new root for %q: %+v", tp, s.Parent)
		}
	}
}

func TestSampling(t *testing.T) {
	tr, exp := obsInit(t, 0)
	obsServe(tr, http.MethodGet, "/x", "", 0)
	if n := len(exp.GetSpans()); n != 0 {
		t.Fatalf("ratio 0 exported %d", n)
	}
	tr, exp = obsInit(t, 1)
	obsServe(tr, http.MethodGet, "/x", "", 0)
	if n := len(exp.GetSpans()); n != 1 {
		t.Fatalf("ratio 1 exported %d", n)
	}
	// The caller's unsampled decision wins over ratio 1.
	tr, exp = obsInit(t, 1)
	obsServe(tr, http.MethodGet, "/x", "00-"+obsTraceID+"-"+obsSpanID+"-00", 0)
	if n := len(exp.GetSpans()); n != 0 {
		t.Fatalf("unsampled parent exported %d", n)
	}
}

func TestServerErrorMarksSpan(t *testing.T) {
	tr, exp := obsInit(t, 1)
	obsServe(tr, http.MethodGet, "/x", "", http.StatusInternalServerError)
	obsServe(tr, http.MethodGet, "/x", "", http.StatusBadRequest)
	spans := exp.GetSpans()
	if spans[0].Status.Code != codes.Error || obsAttr(spans[0], "http.response.status_code") != "500" {
		t.Fatalf("5xx not failed: %+v", spans[0].Status)
	}
	if spans[1].Status.Code == codes.Error {
		t.Fatal("4xx must not fail the span")
	}
}

func TestSpanNamesHaveNoIdentifiers(t *testing.T) {
	tr, exp := obsInit(t, 1)
	obsServe(tr, http.MethodGet, "/v1/devices/3f2b8a52-1c1d-4e0a-9b7e-0a1b2c3d4e5f/readings/12345", "", 0)
	obsServe(tr, http.MethodGet, "/v1/a1/b", "", 0)
	spans := exp.GetSpans()
	if spans[0].Name != "GET /v1/devices/:id/readings/:id" {
		t.Fatalf("name = %q", spans[0].Name)
	}
	if spans[1].Name != "GET /v1/a1/b" {
		t.Fatalf("single digit kept: %q", spans[1].Name)
	}
	if !strings.Contains(obsAttr(spans[0], "url.path"), "12345") {
		t.Fatal("raw path must stay in url.path")
	}
}

func TestActiveTraceparent(t *testing.T) {
	if tp, ok := ActiveTraceparent(context.Background()); ok || tp != "" {
		t.Fatalf("no span: %q %v", tp, ok)
	}
	tid, _ := trace.TraceIDFromHex(obsTraceID)
	sid, _ := trace.SpanIDFromHex(obsSpanID)
	for flags, want := range map[trace.TraceFlags]string{0x03: "01", 0x02: "00", 0x01: "01", 0x00: "00"} {
		ctx := trace.ContextWithSpanContext(context.Background(),
			trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: sid, TraceFlags: flags}))
		got, ok := ActiveTraceparent(ctx)
		if !ok || got != "00-"+obsTraceID+"-"+obsSpanID+"-"+want {
			t.Fatalf("flags %x: %q", flags, got)
		}
	}
}

func TestOTLPBranchShutdownDoesNotHang(t *testing.T) {
	tr, err := InitTracing(TracingConfig{ServiceName: "svc", OTLPEndpoint: "http://127.0.0.1:1", SampleRatio: 1})
	if err != nil {
		t.Fatal(err)
	}
	obsServe(tr, http.MethodGet, "/x", "", 0)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { _ = tr.Shutdown(ctx); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown hung")
	}
}

func TestInvalidEndpoint(t *testing.T) {
	for _, ep := range []string{"://bad", "collector:4318", "ftp://host", "http://"} {
		if tr, err := InitTracing(TracingConfig{ServiceName: "svc", OTLPEndpoint: ep}); err == nil || tr != nil {
			t.Fatalf("%q accepted", ep)
		}
	}
}

func TestNoExporterAndReinit(t *testing.T) {
	for i := 0; i < 2; i++ {
		tr, err := InitTracing(TracingConfig{ServiceName: "svc", SampleRatio: 1})
		if err != nil {
			t.Fatal(err)
		}
		obsServe(tr, http.MethodGet, "/x", "", 0)
		if err := tr.Shutdown(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	// Global provider was reset: a new init still works with an exporter.
	_, exp := obsInit(t, 1)
	if exp == nil {
		t.Fatal("no exporter")
	}
}

var _ sdktrace.SpanExporter = (*tracetest.InMemoryExporter)(nil)

func TestOTLPExportPostsToTheTracesPath(t *testing.T) {
	for suffix, wantPath := range map[string]string{"": "/v1/traces", "/": "/v1/traces", "/otel": "/otel/v1/traces"} {
		paths := make(chan string, 4)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			paths <- r.URL.Path
		}))
		tr, err := InitTracing(TracingConfig{ServiceName: "otlp-path", OTLPEndpoint: srv.URL + suffix, SampleRatio: 1})
		if err != nil {
			t.Fatal(err)
		}
		_, span := tr.Tracer.Start(context.Background(), "probe")
		span.End()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := tr.Shutdown(ctx); err != nil {
			t.Fatalf("shutdown: %v", err)
		}
		cancel()
		select {
		case got := <-paths:
			if got != wantPath {
				t.Errorf("endpoint %q: posted to %q, want %q", suffix, got, wantPath)
			}
		default:
			t.Errorf("endpoint %q: the collector received nothing", suffix)
		}
		srv.Close()
	}
}
