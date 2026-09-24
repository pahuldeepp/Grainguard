package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func obsScrape(m *Metrics) string {
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	return rec.Body.String()
}

func TestMetricsExactText(t *testing.T) {
	m := NewMetrics()
	m.IncRejection(ReasonInvalidBody)
	m.IncRejection(ReasonInvalidBody)
	m.IncRejection("tenant-123-secret")
	m.IncAccepted()
	want := `# HELP ingest_rejections_total Readings rejected, by reason.
# TYPE ingest_rejections_total counter
ingest_rejections_total{reason="binding_feed_stale"} 0
ingest_rejections_total{reason="device_disabled"} 0
ingest_rejections_total{reason="device_forbidden"} 0
ingest_rejections_total{reason="device_not_ready"} 0
ingest_rejections_total{reason="idempotency_conflict"} 0
ingest_rejections_total{reason="invalid_body"} 2
ingest_rejections_total{reason="invalid_field"} 0
ingest_rejections_total{reason="no_measurements"} 0
ingest_rejections_total{reason="non_finite_value"} 0
ingest_rejections_total{reason="other"} 1
ingest_rejections_total{reason="rate_limited"} 0
ingest_rejections_total{reason="timestamp_in_future"} 0
ingest_rejections_total{reason="timestamp_too_old"} 0
ingest_rejections_total{reason="value_out_of_range"} 0
# HELP ingest_readings_accepted_total Readings accepted and stored.
# TYPE ingest_readings_accepted_total counter
ingest_readings_accepted_total 1
`
	if got := obsScrape(m); got != want {
		t.Fatalf("got:\n%s", got)
	}
}

func TestMetricsHandlerMethodAndHeaders(t *testing.T) {
	m := NewMetrics()
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/metrics", nil))
	if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("code %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain") {
		t.Fatal("content type")
	}
}

func TestMetricsConcurrent(t *testing.T) {
	m := NewMetrics()
	var _ RejectionCounter = m
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				m.IncRejection(ReasonDeviceDisabled)
				m.IncAccepted()
			}
		}()
	}
	wg.Wait()
	out := obsScrape(m)
	if !strings.Contains(out, `{reason="device_disabled"} 5000`) || !strings.Contains(out, "accepted_total 5000") {
		t.Fatalf("lost updates:\n%s", out)
	}
}
