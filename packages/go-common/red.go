package common

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var allowedPoolNames = map[string]bool{"telemetry_ingest": true, "projection_builder": true, "jobs_worker": true}

// RenderPGXPoolMetrics exports bounded client-pool saturation and wait counters.
// Names are a fixed service allowlist; no tenant or query data is accepted.
func RenderPGXPoolMetrics(name string, stats *pgxpool.Stat) string {
	if stats == nil || !allowedPoolNames[name] {
		return ""
	}
	return fmt.Sprintf(`# HELP postgres_pool_size Configured maximum connections in the local pgx pool.
# TYPE postgres_pool_size gauge
postgres_pool_size{pool=%q} %d
# HELP postgres_pool_total_connections Current total connections in the local pgx pool.
# TYPE postgres_pool_total_connections gauge
postgres_pool_total_connections{pool=%q} %d
# HELP postgres_pool_idle_connections Current idle connections in the local pgx pool.
# TYPE postgres_pool_idle_connections gauge
postgres_pool_idle_connections{pool=%q} %d
# HELP postgres_pool_acquired_connections Current acquired connections in the local pgx pool.
# TYPE postgres_pool_acquired_connections gauge
postgres_pool_acquired_connections{pool=%q} %d
# HELP postgres_pool_acquire_total Total connection acquisition attempts.
# TYPE postgres_pool_acquire_total counter
postgres_pool_acquire_total{pool=%q} %d
# HELP postgres_pool_acquire_canceled_total Canceled connection acquisition attempts.
# TYPE postgres_pool_acquire_canceled_total counter
postgres_pool_acquire_canceled_total{pool=%q} %d
# HELP postgres_pool_empty_acquire_total Acquisition attempts that found no immediately idle connection.
# TYPE postgres_pool_empty_acquire_total counter
postgres_pool_empty_acquire_total{pool=%q} %d
# HELP postgres_pool_acquire_wait_seconds_total Cumulative time waiting to acquire a connection.
# TYPE postgres_pool_acquire_wait_seconds_total counter
postgres_pool_acquire_wait_seconds_total{pool=%q} %g
# HELP postgres_pool_empty_acquire_wait_seconds_total Cumulative wait when no idle connection was immediately available.
# TYPE postgres_pool_empty_acquire_wait_seconds_total counter
postgres_pool_empty_acquire_wait_seconds_total{pool=%q} %g
`, name, stats.MaxConns(), name, stats.TotalConns(), name, stats.IdleConns(), name, stats.AcquiredConns(), name, stats.AcquireCount(), name, stats.CanceledAcquireCount(), name, stats.EmptyAcquireCount(), name, stats.AcquireDuration().Seconds(), name, stats.EmptyAcquireWaitTime().Seconds())
}

var redLatencyBounds = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

type redKey struct{ method, route, status string }
type redValue struct {
	count   uint64
	sum     float64
	buckets []uint64
}
type redStore struct {
	mu     sync.Mutex
	values map[redKey]*redValue
}

var processRED = redStore{values: make(map[redKey]*redValue)}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
func (w *statusWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(p)
}

// REDMetrics records request count and latency by finite method, ServeMux route
// pattern, and status code. It excludes probes and the metrics endpoint itself.
func REDMetrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/metrics" || r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			next.ServeHTTP(w, r)
			return
		}
		started := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		status := sw.status
		if status == 0 {
			status = http.StatusOK
		}
		route := r.Pattern
		if route != "" {
			route = strings.Join(strings.Fields(route), " ")
		}
		if route == "" {
			route = "unmatched"
		}
		key := redKey{method: boundedMethod(r.Method), route: route, status: strconv.Itoa(status)}
		seconds := time.Since(started).Seconds()
		processRED.mu.Lock()
		v := processRED.values[key]
		if v == nil {
			v = &redValue{buckets: make([]uint64, len(redLatencyBounds))}
			processRED.values[key] = v
		}
		v.count++
		v.sum += seconds
		for i, bound := range redLatencyBounds {
			if seconds <= bound {
				v.buckets[i]++
			}
		}
		processRED.mu.Unlock()
	})
}

func boundedMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodHead, http.MethodOptions:
		return method
	default:
		return "OTHER"
	}
}

// RenderREDMetrics returns stable Prometheus exposition; labels are finite
// route templates and status codes, never raw paths or request identifiers.
func RenderREDMetrics() string {
	processRED.mu.Lock()
	defer processRED.mu.Unlock()
	keys := make([]redKey, 0, len(processRED.values))
	for key := range processRED.values {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		return strings.Join([]string{a.method, a.route, a.status}, "\x00") < strings.Join([]string{b.method, b.route, b.status}, "\x00")
	})
	var out strings.Builder
	out.WriteString("# HELP http_server_requests_total Completed HTTP requests.\n# TYPE http_server_requests_total counter\n")
	out.WriteString("# HELP http_server_duration_seconds HTTP request duration in seconds.\n# TYPE http_server_duration_seconds histogram\n")
	for _, key := range keys {
		value := processRED.values[key]
		labels := fmt.Sprintf("method=%q,route=%q,status_code=%q", key.method, key.route, key.status)
		fmt.Fprintf(&out, "http_server_requests_total{%s} %d\n", labels, value.count)
		for i, bound := range redLatencyBounds {
			fmt.Fprintf(&out, "http_server_duration_seconds_bucket{%s,le=%q} %d\n", labels, strconv.FormatFloat(bound, 'f', -1, 64), value.buckets[i])
		}
		fmt.Fprintf(&out, "http_server_duration_seconds_bucket{%s,le=\"+Inf\"} %d\n", labels, value.count)
		fmt.Fprintf(&out, "http_server_duration_seconds_sum{%s} %g\nhttp_server_duration_seconds_count{%s} %d\n", labels, value.sum, labels, value.count)
	}
	return out.String()
}
