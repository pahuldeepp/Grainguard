package main

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync/atomic"
)

const reasonOther = "other"

var knownReasons = []string{
	ReasonInvalidBody, ReasonInvalidField, ReasonNoMeasurements, ReasonNonFiniteValue,
	ReasonValueOutOfRange, ReasonTimestampInFuture, ReasonTimestampTooOld, ReasonDeviceForbidden,
	ReasonDeviceNotReady, ReasonDeviceDisabled, ReasonIdempotencyConflict, ReasonRateLimited, reasonOther,
}

// Metrics holds ingest counters. The reason map is fixed at construction, so reads need no lock.
type Metrics struct {
	rejections map[string]*atomic.Int64
	accepted   atomic.Int64
}

func NewMetrics() *Metrics {
	m := &Metrics{rejections: make(map[string]*atomic.Int64, len(knownReasons))}
	for _, r := range knownReasons {
		m.rejections[r] = new(atomic.Int64)
	}
	return m
}

// IncRejection counts a rejection; unknown reasons are clamped to "other" to bound label cardinality.
func (m *Metrics) IncRejection(reason string) {
	c, ok := m.rejections[reason]
	if !ok {
		c = m.rejections[reasonOther]
	}
	c.Add(1)
}

func (m *Metrics) IncAccepted() { m.accepted.Add(1) }

func (m *Metrics) render() string {
	reasons := append([]string(nil), knownReasons...)
	sort.Strings(reasons)
	var b strings.Builder
	b.WriteString("# HELP ingest_rejections_total Readings rejected, by reason.\n")
	b.WriteString("# TYPE ingest_rejections_total counter\n")
	for _, r := range reasons {
		fmt.Fprintf(&b, "ingest_rejections_total{reason=%q} %d\n", r, m.rejections[r].Load())
	}
	b.WriteString("# HELP ingest_readings_accepted_total Readings accepted and stored.\n")
	b.WriteString("# TYPE ingest_readings_accepted_total counter\n")
	fmt.Fprintf(&b, "ingest_readings_accepted_total %d\n", m.accepted.Load())
	return b.String()
}

// Handler serves the Prometheus text exposition format.
func (m *Metrics) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = fmt.Fprint(w, m.render())
	})
}
