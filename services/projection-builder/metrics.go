package main

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

type partitionKey struct {
	topic     string
	partition int32
}
type observations struct {
	lag     map[partitionKey]int64
	mu      sync.Mutex
	count   uint64
	sum     float64
	buckets [5]uint64
	last    time.Time
	pending atomic.Int64
}

var latencyBounds = [5]float64{1, 5, 30, 60, 300}

func (o *observations) observe(delay time.Duration) {
	o.mu.Lock()
	defer o.mu.Unlock()
	seconds := max(0, delay.Seconds())
	o.count++
	o.sum += seconds
	o.last = time.Now()
	for i, b := range latencyBounds {
		if seconds <= b {
			o.buckets[i]++
		}
	}
}
func (a *app) metrics(w http.ResponseWriter, r *http.Request) {
	p := a.processor
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = fmt.Fprintf(w, "projection_applied_total %d\nprojection_duplicates_total %d\nprojection_collisions_total %d\nprojection_quarantined_total %d\nprojection_retries_total %d\nprojection_pending_records %d\n", p.Applied.Load(), p.Duplicates.Load(), p.Collisions.Load(), p.Quarantined.Load(), p.Retries.Load(), p.Observations.pending.Load())
	var outside uint64
	if a.historyOutOfWindow != nil {
		outside = a.historyOutOfWindow()
	}
	_, _ = fmt.Fprintf(w, "projection_history_out_of_window_total %d\n", outside)
	age := math.Inf(1)
	if a.feedAge != nil {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if d, err := a.feedAge(ctx); err == nil {
			age = d.Seconds()
		}
	}
	_, _ = fmt.Fprintf(w, "projection_binding_feed_age_seconds %g\n", age)
	p.Observations.render(w)
}
func (o *observations) render(w http.ResponseWriter) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for key, lag := range o.lag {
		_, _ = fmt.Fprintf(w, "projection_lag_records{topic=%q,partition=\"%d\"} %d\n", key.topic, key.partition, lag)
	}
	age := math.Inf(1)
	if !o.last.IsZero() {
		age = time.Since(o.last).Seconds()
	}
	_, _ = fmt.Fprintf(w, "projection_last_projected_age_seconds %g\n# TYPE projection_event_to_projection_seconds histogram\n", age)
	for i, b := range latencyBounds {
		_, _ = fmt.Fprintf(w, "projection_event_to_projection_seconds_bucket{le=\"%g\"} %d\n", b, o.buckets[i])
	}
	_, _ = fmt.Fprintf(w, "projection_event_to_projection_seconds_bucket{le=\"+Inf\"} %d\nprojection_event_to_projection_seconds_count %d\nprojection_event_to_projection_seconds_sum %g\n", o.count, o.count, o.sum)
}

// Lag is the last fetched broker high watermark minus the locally acknowledged
// frontier; it is not a continuously polled cluster-wide backlog estimate.
func (o *observations) frontier(m Message, committed bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.lag == nil {
		o.lag = make(map[partitionKey]int64)
	}
	offset := m.Offset
	if committed {
		offset++
	}
	o.lag[partitionKey{m.Topic, m.Partition}] = max(0, m.EndOffset-offset)
}
