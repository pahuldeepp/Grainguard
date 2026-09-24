package main

import (
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
)

var reasons = []string{reasonEnvelope, reasonOp, reasonMissing, reasonSchema, reasonUnknown, reasonTimestamp, reasonBigint}
var ignoredOps = []string{"u", "d", opTombstone}

type Metrics struct {
	consumed, published, lag atomic.Int64
	quarantined, ignored     map[string]*atomic.Int64
	ready                    atomic.Bool
}

func newMetrics() *Metrics {
	m := &Metrics{quarantined: make(map[string]*atomic.Int64), ignored: make(map[string]*atomic.Int64)}
	for _, reason := range reasons {
		m.quarantined[reason] = new(atomic.Int64)
	}
	for _, op := range ignoredOps {
		m.ignored[op] = new(atomic.Int64)
	}
	m.ready.Store(true)
	return m
}
func (m *Metrics) render() string {
	var b strings.Builder
	fmt.Fprintf(&b, "# TYPE cdc_consumed_total counter\ncdc_consumed_total %d\n", m.consumed.Load())
	fmt.Fprintf(&b, "# TYPE cdc_published_total counter\ncdc_published_total %d\n", m.published.Load())
	fmt.Fprintf(&b, "# HELP cdc_commit_lag Fetched records awaiting confirmed offset commit.\n# TYPE cdc_commit_lag gauge\ncdc_commit_lag %d\n", m.lag.Load())
	b.WriteString("# TYPE cdc_quarantined_total counter\n")
	for _, reason := range reasons {
		fmt.Fprintf(&b, "cdc_quarantined_total{reason=%q} %d\n", reason, m.quarantined[reason].Load())
	}
	b.WriteString("# TYPE cdc_ignored_total counter\n")
	for _, op := range ignoredOps {
		fmt.Fprintf(&b, "cdc_ignored_total{operation=%q} %d\n", op, m.ignored[op].Load())
	}
	return b.String()
}
func (m *Metrics) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = fmt.Fprint(w, m.render())
}
