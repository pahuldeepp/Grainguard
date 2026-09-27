package saga

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
)

// States lists every saga state so each gauge is emitted even when zero.
var States = []string{"reserving", "configuring", "activating", "active", "compensating", "compensated", "repair_required"}

// latencyBuckets (seconds) span a normal step (sub-second) to the 15-minute deadline.
var latencyBuckets = []float64{0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900}

// Metrics are process-wide. They never carry tenant, saga, device or command
// labels; the only labels are the bounded state and step names.
type Metrics struct {
	LeaseLost          atomic.Int64
	DeadlinesExpired   atomic.Int64
	CommandsPublished  atomic.Int64
	ResultsApplied     atomic.Int64
	ResultsQuarantined atomic.Int64

	mu      sync.Mutex
	buckets map[string][]int64
	sums    map[string]float64
	counts  map[string]int64
}

// ObserveStepLatency records command-creation-to-result time for one step.
func (m *Metrics) ObserveStepLatency(step string, d time.Duration) {
	if m == nil {
		return
	}
	if _, ok := routes[step]; !ok {
		step = "unknown"
	}
	seconds := d.Seconds()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.buckets == nil {
		m.buckets, m.sums, m.counts = map[string][]int64{}, map[string]float64{}, map[string]int64{}
	}
	if m.buckets[step] == nil {
		m.buckets[step] = make([]int64, len(latencyBuckets))
	}
	for i, le := range latencyBuckets {
		if seconds <= le {
			m.buckets[step][i]++
		}
	}
	m.sums[step] += seconds
	m.counts[step]++
}

// Gauges is an aggregate, tenant-free view of the saga database.
type Gauges struct {
	States          map[string]int64
	Overdue         int64
	PendingCommands int64
	OldestPending   float64
}

// Querier is the read capability the gauges need.
type Querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// ReadGauges calls the count-only SECURITY DEFINER functions from 000006.
func ReadGauges(ctx context.Context, db Querier) (Gauges, error) {
	g := Gauges{States: map[string]int64{}}
	rows, err := db.Query(ctx, `SELECT state, sagas, overdue FROM saga_state_metrics()`)
	if err != nil {
		return g, err
	}
	defer rows.Close()
	for rows.Next() {
		var state string
		var n, overdue int64
		if err := rows.Scan(&state, &n, &overdue); err != nil {
			return g, err
		}
		g.States[state] = n
		g.Overdue += overdue
	}
	if err := rows.Err(); err != nil {
		return g, err
	}
	err = db.QueryRow(ctx, `SELECT pending, oldest_age_seconds FROM saga_pending_command_metrics()`).Scan(&g.PendingCommands, &g.OldestPending)
	return g, err
}

// Write renders Prometheus text exposition format.
func (m *Metrics) Write(w io.Writer, g Gauges) {
	for _, state := range States {
		_, _ = fmt.Fprintf(w, "saga_state_count{state=%q} %d\n", state, g.States[state])
	}
	_, _ = fmt.Fprintf(w, "saga_repair_required %d\nsaga_compensation_backlog %d\nsaga_deadline_overdue %d\n",
		g.States["repair_required"], g.States["compensating"], g.Overdue)
	_, _ = fmt.Fprintf(w, "saga_commands_pending %d\nsaga_commands_oldest_pending_seconds %g\n", g.PendingCommands, g.OldestPending)
	if m == nil {
		return
	}
	_, _ = fmt.Fprintf(w, "saga_lease_lost_total %d\nsaga_deadlines_expired_total %d\nsaga_commands_published_total %d\nsaga_results_applied_total %d\nsaga_results_quarantined_total %d\n",
		m.LeaseLost.Load(), m.DeadlinesExpired.Load(), m.CommandsPublished.Load(), m.ResultsApplied.Load(), m.ResultsQuarantined.Load())
	m.writeHistogram(w)
}

func (m *Metrics) writeHistogram(w io.Writer) {
	m.mu.Lock()
	defer m.mu.Unlock()
	steps := make([]string, 0, len(m.counts))
	for step := range m.counts {
		steps = append(steps, step)
	}
	sort.Strings(steps)
	for _, step := range steps {
		for i, le := range latencyBuckets {
			_, _ = fmt.Fprintf(w, "saga_step_latency_seconds_bucket{step=%q,le=\"%g\"} %d\n", step, le, m.buckets[step][i])
		}
		_, _ = fmt.Fprintf(w, "saga_step_latency_seconds_bucket{step=%q,le=\"+Inf\"} %d\n", step, m.counts[step])
		_, _ = fmt.Fprintf(w, "saga_step_latency_seconds_sum{step=%q} %g\nsaga_step_latency_seconds_count{step=%q} %d\n", step, m.sums[step], step, m.counts[step])
	}
}

// Handler serves GET /metrics. A database failure is reported as 503 so the
// scrape itself signals that the gauges are unavailable.
func Handler(m *Metrics, db Querier) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		g, err := ReadGauges(ctx, db)
		if err != nil {
			http.Error(w, "saga metrics unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		m.Write(w, g)
	})
}

// CommandAge is the time since the command was queued, read under tenant RLS.
func (s Store) CommandAge(ctx context.Context, tenantID, commandID string) (string, time.Duration, error) {
	var step string
	var seconds float64
	if !common.TenantPattern.MatchString(tenantID) || !common.TenantPattern.MatchString(commandID) {
		return "", 0, ErrInvalidRequest
	}
	err := common.WithTenantSchema(ctx, s.DB, tenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT step, EXTRACT(EPOCH FROM now()-created_at)::double precision
			FROM saga_command_outbox WHERE tenant_id=$1 AND command_id=$2`, tenantID, commandID).Scan(&step, &seconds)
	})
	return step, time.Duration(seconds * float64(time.Second)), err
}
