package common

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type placementTestTx struct {
	pgx.Tx
	statements []string
	arguments  [][]any
	execErr    error
	commitErr  error
	commits    int
	rollbacks  int
}

func (t *placementTestTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	t.statements = append(t.statements, sql)
	t.arguments = append(t.arguments, args)
	if strings.Contains(sql, "admit_tenant_placement") {
		return pgconn.CommandTag{}, t.execErr
	}
	return pgconn.CommandTag{}, nil
}
func (t *placementTestTx) Commit(context.Context) error   { t.commits++; return t.commitErr }
func (t *placementTestTx) Rollback(context.Context) error { t.rollbacks++; return nil }

type placementTestDB struct {
	tx     *placementTestTx
	begins int
}

func (d *placementTestDB) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) {
	d.begins++
	return d.tx, nil
}

func TestWithTenantPlacementSetsRouteAndAdmitsBeforeCallback(t *testing.T) {
	tx := &placementTestTx{}
	db := &placementTestDB{tx: tx}
	route := TenantPlacement{TenantID: "3f2b8c1e-9a4d-4e7b-8c55-1d2e3f4a5b6c", ShardID: "s3", Incarnation: "4f2b8c1e-9a4d-4e7b-8c55-1d2e3f4a5b6c", PlacementEpoch: "9223372036854775807", State: "active", ExpiresAt: time.Now().Add(time.Minute)}
	called := false
	err := WithTenantPlacement(context.Background(), db, route, func(context.Context, pgx.Tx) error {
		called = true
		if len(tx.statements) != 5 || !strings.Contains(tx.statements[4], "admit_tenant_placement") {
			t.Fatalf("callback ran before placement admission: %v", tx.statements)
		}
		return nil
	})
	if err != nil || !called || db.begins != 1 || tx.commits != 1 || tx.rollbacks != 0 {
		t.Fatalf("err=%v called=%v begins=%d commits=%d rollbacks=%d", err, called, db.begins, tx.commits, tx.rollbacks)
	}
	if len(tx.arguments) != 5 || tx.arguments[0][1] != route.TenantID || tx.arguments[1][1] != route.ShardID || tx.arguments[2][1] != route.Incarnation || tx.arguments[3][1] != route.PlacementEpoch {
		t.Fatalf("route context arguments mismatch: %#v", tx.arguments)
	}
}

func TestWithTenantPlacementRejectsInvalidAndInactiveRoutesBeforeBegin(t *testing.T) {
	base := TenantPlacement{TenantID: "3f2b8c1e-9a4d-4e7b-8c55-1d2e3f4a5b6c", ShardID: "s1", Incarnation: "4f2b8c1e-9a4d-4e7b-8c55-1d2e3f4a5b6c", PlacementEpoch: "1", State: "active", ExpiresAt: time.Now().Add(time.Minute)}
	cases := []TenantPlacement{base, base, base, base, base, base, base}
	cases[0].ShardID = "s5"
	cases[1].PlacementEpoch = "9223372036854775808"
	cases[2].PlacementEpoch = "01"
	cases[3].State = "quiescing"
	cases[4].Incarnation = ""
	cases[5].ExpiresAt = time.Time{}
	cases[6].ExpiresAt = time.Now().Add(-time.Second)
	for _, route := range cases {
		db := &placementTestDB{tx: &placementTestTx{}}
		if err := WithTenantPlacement(context.Background(), db, route, func(context.Context, pgx.Tx) error { t.Fatal("callback unexpectedly ran"); return nil }); !errors.Is(err, ErrInvalidTenantPlacement) || db.begins != 0 {
			t.Fatalf("route=%+v err=%v begins=%d", route, err, db.begins)
		}
	}
}

func TestExpiredPlacementBeforeBeginReportsOnlyExpiryTimingAndRetainsErrorIdentity(t *testing.T) {
	tx := &placementTestTx{}
	db := &placementTestDB{tx: tx}
	expires := time.Now().Add(-time.Second)
	route := TenantPlacement{TenantID: tenantID, ShardID: "s1", Incarnation: tenantID, PlacementEpoch: "1", State: "active", ExpiresAt: expires}
	err := WithTenantPlacement(context.Background(), db, route, func(context.Context, pgx.Tx) error { t.Fatal("expired route invoked callback"); return nil })
	if !errors.Is(err, ErrInvalidTenantPlacement) || db.begins != 0 || len(tx.statements) != 0 || tx.rollbacks != 0 {
		t.Fatalf("expired route reached transaction: err=%v begins=%d tx=%+v", err, db.begins, tx)
	}
	if !strings.Contains(err.Error(), "expired before transaction begin") || !strings.Contains(err.Error(), "expires_at="+expires.UTC().Format(time.RFC3339Nano)) || !strings.Contains(err.Error(), "observed_at=") {
		t.Fatalf("pre-begin expiry diagnostic missing: %v", err)
	}
	if strings.Contains(err.Error(), tenantID) || strings.Contains(err.Error(), "placement_epoch") {
		t.Fatalf("diagnostic exposed route identity: %v", err)
	}
}

func TestMalformedPlacementDoesNotBecomeExpiryDiagnostic(t *testing.T) {
	base := TenantPlacement{TenantID: tenantID, ShardID: "s1", Incarnation: tenantID, PlacementEpoch: "1", State: "active", ExpiresAt: time.Now().Add(-time.Second)}
	for _, mutate := range []func(*TenantPlacement){
		func(p *TenantPlacement) { p.TenantID = "bad" },
		func(p *TenantPlacement) { p.ShardID = "s5" },
		func(p *TenantPlacement) { p.Incarnation = "bad" },
		func(p *TenantPlacement) { p.PlacementEpoch = "01" },
		func(p *TenantPlacement) { p.PlacementEpoch = "9223372036854775808" },
		func(p *TenantPlacement) { p.PlacementEpoch = "0" },
		func(p *TenantPlacement) { p.State = "quiescing" },
		func(p *TenantPlacement) { p.ExpiresAt = time.Time{} },
	} {
		route := base
		mutate(&route)
		db := &placementTestDB{tx: &placementTestTx{}}
		err := WithTenantPlacement(context.Background(), db, route, func(context.Context, pgx.Tx) error { t.Fatal("invalid route invoked callback"); return nil })
		if err != ErrInvalidTenantPlacement || db.begins != 0 {
			t.Fatalf("invalid route reclassified: err=%v begins=%d", err, db.begins)
		}
	}
}

func TestWithTenantPlacementRollsBackWhenDatabaseRejectsAdmission(t *testing.T) {
	denied := errors.New("stale placement")
	tx := &placementTestTx{execErr: denied}
	db := &placementTestDB{tx: tx}
	route := TenantPlacement{TenantID: "3f2b8c1e-9a4d-4e7b-8c55-1d2e3f4a5b6c", ShardID: "s1", Incarnation: "4f2b8c1e-9a4d-4e7b-8c55-1d2e3f4a5b6c", PlacementEpoch: "1", State: "active", ExpiresAt: time.Now().Add(time.Minute)}
	called := false
	err := WithTenantPlacement(context.Background(), db, route, func(context.Context, pgx.Tx) error { called = true; return nil })
	if !errors.Is(err, denied) || called || tx.commits != 0 || tx.rollbacks != 1 {
		t.Fatalf("err=%v called=%v commits=%d rollbacks=%d", err, called, tx.commits, tx.rollbacks)
	}
}

func TestCanonicalEnvelopeHelpers(t *testing.T) {
	value, err := Decode([]byte(`{"n":9223372036854775807}`))
	if err != nil || value.(map[string]any)["n"] != json.Number("9223372036854775807") {
		t.Fatal(value, err)
	}
	if _, err := Decode([]byte(`{} {}`)); err == nil {
		t.Fatal("trailing document accepted")
	}
	for _, invalid := range []any{"01", "0", "9223372036854775808", 1.0} {
		if _, err := Bigint(invalid); err == nil {
			t.Fatalf("accepted %v", invalid)
		}
	}
	if got, err := Bigint(json.Number("7")); err != nil || got != "7" {
		t.Fatal(got, err)
	}
}

func TestPGXPoolMetricsUseFixedPoolNamesAndExposeSaturation(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), "postgres://user:pass@127.0.0.1:1/db?pool_max_conns=7")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	text := RenderPGXPoolMetrics("telemetry_ingest", pool.Stat())
	for _, expected := range []string{
		`postgres_pool_size{pool="telemetry_ingest"} 7`,
		`postgres_pool_total_connections{pool="telemetry_ingest"} 0`,
		`postgres_pool_idle_connections{pool="telemetry_ingest"} 0`,
		`postgres_pool_acquired_connections{pool="telemetry_ingest"} 0`,
		`postgres_pool_empty_acquire_wait_seconds_total{pool="telemetry_ingest"} 0`,
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %q in %s", expected, text)
		}
	}
	if leaked := RenderPGXPoolMetrics(`tenant_123`, pool.Stat()); leaked != "" {
		t.Fatalf("unbounded pool name accepted: %s", leaked)
	}
}

func TestSchemaCompilationAndValidationBoundary(t *testing.T) {
	dir := filepath.Join("..", "..", "contracts", "events")
	schemas, err := CompileSchemas(dir, map[string]string{"device.registered@1": "device-registered.v1.schema.json"})
	if err != nil || len(schemas) != 1 {
		t.Fatal(err)
	}
	if _, err := CompileSchemas(dir, map[string]string{"missing": "missing.json"}); err == nil {
		t.Fatal("missing schema accepted")
	}
	type failure string
	fail := func(reason, _ string) failure { return failure(reason) }
	semantic := func(map[string]any) failure { return "semantic" }
	route := func(event map[string]any) string { return event["route"].(string) }
	if got := ValidateEvent(map[string]any{"route": "missing"}, schemas, route, "unknown", "invalid", fail, semantic); got != "unknown" {
		t.Fatal(got)
	}
	if got := ValidateEvent(map[string]any{"route": "device.registered@1"}, schemas, route, "unknown", "invalid", fail, semantic); got != "invalid" {
		t.Fatal(got)
	}
}
func TestTracingConfiguration(t *testing.T) {
	if _, err := InitTracing("test", "not-an-endpoint"); err == nil {
		t.Fatal("invalid endpoint accepted")
	}
	provider, err := InitTracing("test", "")
	if err != nil {
		t.Fatal(err)
	}
	ShutdownTracing(provider, time.Second)
}

func TestHealthRoutesAndBounds(t *testing.T) {
	ready := true
	handler := HealthHandler(func() bool { return ready }, func(context.Context) error { return nil }, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/healthz", nil))
	if response.Code != http.StatusOK || response.Body.String() != "ok\n" {
		t.Fatal(response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/readyz", nil))
	if response.Code != http.StatusOK {
		t.Fatal(response.Code)
	}
	ready = false
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/readyz", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatal(response.Code)
	}
	server := HTTPServer("127.0.0.1:1", handler)
	if server.ReadHeaderTimeout == 0 || server.ReadTimeout == 0 || server.WriteTimeout == 0 {
		t.Fatal("missing server bounds")
	}
}

func TestREDMetricsUseRouteTemplatesAndExcludeProbes(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/devices/{deviceID}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("deviceID") == "bad" {
			http.Error(w, "failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	handler := REDMetrics(mux)
	for _, path := range []string{"/v1/devices/one", "/v1/devices/two", "/v1/devices/bad"} {
		r := httptest.NewRecorder()
		handler.ServeHTTP(r, httptest.NewRequest(http.MethodGet, path, nil))
	}
	metricsBefore := RenderREDMetrics()
	if !strings.Contains(metricsBefore, `route="GET /v1/devices/{deviceID}"`) || !strings.Contains(metricsBefore, `status_code="500"`) {
		t.Fatalf("route template/status missing: %s", metricsBefore)
	}
	if strings.Contains(metricsBefore, "one") || strings.Contains(metricsBefore, "two") || strings.Contains(metricsBefore, `route="GET /v1/devices/bad"`) {
		t.Fatalf("request path value leaked into labels: %s", metricsBefore)
	}
	count := strings.Count(metricsBefore, `route="GET /v1/devices/{deviceID}"`)
	probeMux := http.NewServeMux()
	probeMux.HandleFunc("GET /healthz", func(http.ResponseWriter, *http.Request) {})
	probeHandler := REDMetrics(probeMux)
	probeHandler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if got := strings.Count(RenderREDMetrics(), `route="GET /v1/devices/{deviceID}"`); got != count {
		t.Fatalf("health probe affected RED series count: before=%d after=%d", count, got)
	}
}

func TestServeWorkerCancelsAndDrains(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	stopped := false
	worker := func(ctx context.Context) error { <-ctx.Done(); stopped = true; return ctx.Err() }
	cancel()
	if err := ServeWorker(ctx, HTTPServer(listener.Addr().String(), http.NewServeMux()), listener, worker, func() {}, nil, time.Second); err != nil {
		t.Fatal(err)
	}
	if !stopped {
		t.Fatal("worker not drained")
	}
}

func TestServeWorkerBoundsUnresponsiveWorker(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	workerStarted, releaseWorker := make(chan struct{}), make(chan struct{})
	defer close(releaseWorker)
	go func() {
		<-workerStarted
		cancel()
	}()
	started := time.Now()
	err = ServeWorker(ctx, HTTPServer(listener.Addr().String(), http.NewServeMux()), listener,
		func(context.Context) error { close(workerStarted); <-releaseWorker; return nil }, func() {}, nil, 25*time.Millisecond)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected worker shutdown deadline, got %v", err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("shutdown exceeded bound")
	}
}
