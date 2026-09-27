package main

import (
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

var bumpScopes = []string{scopeDevice, scopeTenant, scopeEpoch}

// Metrics are process-wide counters; deliberately no tenant or device labels.
type Metrics struct {
	events, invalid, batches, commits atomic.Int64
	failures, exhausted, skipped      atomic.Int64
	epochPending, lagMillis           atomic.Int64
	bumps                             map[string]*atomic.Int64
	ready                             atomic.Bool
}

func newMetrics() *Metrics {
	m := &Metrics{bumps: map[string]*atomic.Int64{}}
	for _, scope := range bumpScopes {
		m.bumps[scope] = new(atomic.Int64)
	}
	m.ready.Store(true)
	return m
}

// observe records a flushed batch. Lag is commit-to-bump latency of its oldest notification.
func (m *Metrics) observe(b *batch, targets int, now time.Time) {
	if b.events == 0 {
		return
	}
	m.batches.Add(1)
	m.events.Add(int64(b.events))
	m.invalid.Add(int64(b.invalid))
	if targets > 0 {
		m.lagMillis.Store(now.Sub(b.oldest).Milliseconds())
	}
}

func (m *Metrics) render() string {
	var b strings.Builder
	counter := func(name, help string, value int64) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", name, help, name, name, value)
	}
	counter("cache_invalidator_events_total", "Notifications consumed.", m.events.Load())
	counter("cache_invalidator_invalid_total", "Notifications rejected by the parser.", m.invalid.Load())
	counter("cache_invalidator_batches_total", "Coalescing windows flushed.", m.batches.Load())
	counter("cache_invalidator_commits_total", "Offset commits after confirmed effects.", m.commits.Load())
	counter("cache_invalidator_bump_failures_total", "Failed Redis bump attempts.", m.failures.Load())
	counter("cache_invalidator_retry_exhausted_total", "Bumps whose retry budget was exhausted.", m.exhausted.Load())
	counter("cache_invalidator_skipped_total", "Bumps superseded by a pending epoch bump.", m.skipped.Load())
	b.WriteString("# HELP cache_invalidator_bumps_total Confirmed version bumps.\n# TYPE cache_invalidator_bumps_total counter\n")
	for _, scope := range bumpScopes {
		fmt.Fprintf(&b, "cache_invalidator_bumps_total{scope=%q} %d\n", scope, m.bumps[scope].Load())
	}
	fmt.Fprintf(&b, "# TYPE cache_invalidator_epoch_pending gauge\ncache_invalidator_epoch_pending %d\n", m.epochPending.Load())
	fmt.Fprintf(&b, "# TYPE cache_invalidator_notification_lag_ms gauge\ncache_invalidator_notification_lag_ms %d\n", m.lagMillis.Load())
	return b.String()
}

func (m *Metrics) serve(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = fmt.Fprint(w, m.render())
}
