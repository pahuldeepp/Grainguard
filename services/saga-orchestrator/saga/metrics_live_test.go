package saga

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

var uuidPattern = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-`)

func TestLiveMetricsAreAggregateAndTenantFree(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s := Store{DB: pool}
	before, err := ReadGauges(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	tenant := testUUID(t)
	snap, err := s.Start(ctx, StartRequest{TenantID: tenant, IdempotencyKey: testUUID(t), DeviceID: testUUID(t), AssetID: testUUID(t)})
	if err != nil {
		t.Fatal(err)
	}
	after, err := ReadGauges(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	// Other suites run concurrently; the new saga can only raise the count.
	if after.States["reserving"] < before.States["reserving"]+1 || after.PendingCommands < 1 {
		t.Fatalf("gauges did not observe the new saga: before=%+v after=%+v", before, after)
	}
	var sent Command
	if ok, err := s.PublishNextCommand(ctx, tenant, func(_ context.Context, _, value []byte) error {
		return json.Unmarshal(value, &sent)
	}); err != nil || !ok {
		t.Fatalf("publish: %v %v", ok, err)
	}
	if sent.CorrelationID != snap.SagaID || !traceparentPattern.MatchString(sent.Traceparent) || strings.Contains(sent.Traceparent, strings.ReplaceAll(snap.SagaID, "-", "")) {
		t.Fatalf("command lacks trace context: %+v", sent)
	}
	step, age, err := s.CommandAge(ctx, tenant, sent.CommandID)
	if err != nil || step != "asset.reserve" || age < 0 {
		t.Fatalf("command age: %s %v %v", step, age, err)
	}
	if _, _, err := s.CommandAge(ctx, testUUID(t), sent.CommandID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("command age crossed tenants: %v", err)
	}
	assertMetricsBody(t, pool, tenant, step, age)
	var visible int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM provisioning_sagas`).Scan(&visible); err != nil || visible != 0 {
		t.Fatalf("runtime role enumerated sagas: %d %v", visible, err)
	}
}

// assertMetricsBody scrapes the handler and checks it is tenant-free and complete.
func assertMetricsBody(t *testing.T, db Querier, tenant, step string, age time.Duration) {
	t.Helper()
	m := &Metrics{}
	m.LeaseLost.Add(1)
	m.ObserveStepLatency(step, age)
	m.ObserveStepLatency("not-a-step", time.Hour)
	rec := httptest.NewRecorder()
	Handler(m, db).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := rec.Body.String()
	if rec.Code != 200 || uuidPattern.MatchString(body) || strings.Contains(body, tenant) {
		t.Fatalf("metrics leaked identifiers or failed: %d\n%s", rec.Code, body)
	}
	for _, want := range []string{`saga_state_count{state="repair_required"}`, "saga_repair_required ", "saga_compensation_backlog ",
		"saga_deadline_overdue ", "saga_lease_lost_total 1", `saga_step_latency_seconds_count{step="asset.reserve"} 1`,
		`saga_step_latency_seconds_bucket{step="unknown",le="+Inf"} 1`} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q in\n%s", want, body)
		}
	}
}

type failingQuerier struct{}

func (failingQuerier) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("db down")
}
func (failingQuerier) QueryRow(context.Context, string, ...any) pgx.Row { return nil }

func TestMetricsHandlerMethodAndFailure(t *testing.T) {
	rec := httptest.NewRecorder()
	Handler(nil, failingQuerier{}).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/metrics", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status=%d", rec.Code)
	}
	rec = httptest.NewRecorder()
	Handler(nil, failingQuerier{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("db failure status=%d", rec.Code)
	}
	var nilMetrics *Metrics
	nilMetrics.ObserveStepLatency("asset.reserve", time.Second)
	rec = httptest.NewRecorder()
	nilMetrics.Write(rec, Gauges{States: map[string]int64{"compensating": 2}})
	if !strings.Contains(rec.Body.String(), "saga_compensation_backlog 2") || strings.Contains(rec.Body.String(), "_total") {
		t.Fatalf("nil metrics output:\n%s", rec.Body.String())
	}
	if _, _, err := (Store{}).CommandAge(context.Background(), "bad", "bad"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("invalid ids accepted: %v", err)
	}
}
