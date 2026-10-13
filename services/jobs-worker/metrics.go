package main

import (
	"fmt"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
)

// Metrics are process-wide counters. They never carry tenant or device labels.
type Metrics struct {
	DBPool           *pgxpool.Pool
	EventsProcessed  atomic.Int64
	EventsDuplicate  atomic.Int64
	EventsQuarantine atomic.Int64
	IntentsCreated   atomic.Int64
	Published        atomic.Int64
	Retried          atomic.Int64
	Dead             atomic.Int64
	ReceiptsApplied  atomic.Int64
	ReceiptsIgnored  atomic.Int64
	InFlight         atomic.Int64
	DLQPublished     atomic.Int64
	DLQPublishFailed atomic.Int64
	Redriven         atomic.Int64
	lagMillis        atomic.Int64
}

func (m *Metrics) observeLag(refs []DueRef) {
	if len(refs) == 0 {
		m.lagMillis.Store(0)
		return
	}
	m.lagMillis.Store(max(0, time.Since(refs[0].Available).Milliseconds()))
}

func (m *Metrics) countDispatch(outcome string) {
	switch outcome {
	case OutcomePublished:
		m.Published.Add(1)
	case OutcomeRetry:
		m.Retried.Add(1)
	case OutcomeDead:
		m.Dead.Add(1)
	}
}

func (m *Metrics) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = fmt.Fprintf(w, `jobs_events_processed_total %d
jobs_events_duplicate_total %d
jobs_events_quarantined_total %d
jobs_intents_created_total %d
jobs_dispatch_published_total %d
jobs_dispatch_retried_total %d
jobs_dispatch_dead_total %d
jobs_receipts_applied_total %d
jobs_receipts_ignored_total %d
jobs_dispatch_in_flight %d
jobs_dlq_published_total %d
jobs_dlq_publish_failed_total %d
jobs_redriven_total %d
jobs_dispatch_lag_seconds %g
`, m.EventsProcessed.Load(), m.EventsDuplicate.Load(), m.EventsQuarantine.Load(), m.IntentsCreated.Load(),
		m.Published.Load(), m.Retried.Load(), m.Dead.Load(), m.ReceiptsApplied.Load(), m.ReceiptsIgnored.Load(),
		m.InFlight.Load(), m.DLQPublished.Load(), m.DLQPublishFailed.Load(), m.Redriven.Load(), float64(m.lagMillis.Load())/1000)
	_, _ = fmt.Fprint(w, common.RenderREDMetrics())
	if m.DBPool != nil {
		_, _ = fmt.Fprint(w, common.RenderPGXPoolMetrics("jobs_worker", m.DBPool.Stat()))
	}
}
