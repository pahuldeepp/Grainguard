package modelgateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

const testTenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const testUser = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

func integrationControls(t *testing.T) (*ProductionControls, *PostgresBudget) {
	t.Helper()
	url := os.Getenv("GATEWAY_TEST_REDIS_URL")
	dsn := os.Getenv("GATEWAY_TEST_BUDGET_DSN")
	if url == "" || dsn == "" {
		t.Skip("run ./acceptance.py for real Redis/Postgres coverage")
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	opts.MaxRetries = -1
	client := redis.NewClient(opts)
	t.Cleanup(func() { client.Close() })
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	b := &PostgresBudget{Pool: pool}
	c := &ProductionControls{Admission: &RedisAdmission{Client: client, Config: AdmissionConfig{Provider: map[string]Limit{"legacy": {10000, 10000, 100}, "atomic": {10000, 10000, 100}}, Tenant: Limit{1000, 1000, 20}, Query: Limit{1000, 1000, 18}, Indexing: Limit{1000, 1000, 2}, User: Limit{1000, 1000, 2}, LeaseSeconds: 45}}, Budget: b, Prices: map[string]Price{"embed-provider": {1000000, 0}, "rerank-provider": {1000000, 5000000}, "answer-provider": {1000000, 5000000}, "fallback-provider": {2000000, 5000000}}, Attempts: 2, AttemptTimeout: time.Second, TotalTimeout: 3 * time.Second, BreakerThreshold: 2, BreakerCooldown: time.Second}
	return c, b
}
func TestLiveRedisAtomicAdmissionAndIsolation(t *testing.T) {
	c, _ := integrationControls(t)
	ctx := context.Background()
	a := c.Admission
	a.Config.User = Limit{2, 0.00001, 2}
	caller := Caller{TenantID: testTenant, PrincipalID: testUser}
	release1, err := a.Acquire(ctx, caller, "query", "atomic", "first")
	if err != nil {
		t.Fatal(err)
	}
	defer release1()
	release2, err := a.Acquire(ctx, caller, "query", "atomic", "second")
	if err != nil {
		t.Fatal(err)
	}
	defer release2()
	var success atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, _ := requestID()
			release, err := a.Acquire(ctx, caller, "query", "atomic", id)
			if err == nil {
				success.Add(1)
				release()
			}
		}()
	}
	wg.Wait()
	if success.Load() != 0 {
		t.Fatal("exhausted user admitted")
	}
	other := Caller{TenantID: testTenant, PrincipalID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}
	release, err := a.Acquire(ctx, other, "query", "atomic", "other")
	if err != nil {
		t.Fatal("other user affected", err)
	}
	release()
	caller.TenantID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	release, err = a.Acquire(ctx, caller, "query", "atomic", "other-tenant")
	if err != nil {
		t.Fatal("other tenant affected", err)
	}
	release()
}
func TestLiveBudgetIsolationAndCrashRecovery(t *testing.T) {
	_, b := integrationControls(t)
	ctx := context.Background()
	id, _ := requestID()
	c := Charge{TenantID: testTenant, ID: id, Model: "test", Provider: "test", Tokens: 10, Micros: 10}
	if err := b.Reserve(ctx, c); err != nil {
		t.Fatal(err)
	}
	tx, err := b.transaction(ctx, "dddddddd-dddd-4ddd-8ddd-dddddddddddd")
	if err != nil {
		t.Fatal(err)
	}
	var count int
	err = tx.QueryRow(ctx, "SELECT count(*) FROM ai_budget_attempts WHERE tenant_id=$1", testTenant).Scan(&count)
	tx.Rollback(ctx)
	if err != nil || count != 0 {
		t.Fatal("cross tenant visible", count, err)
	}
	tx, _ = b.transaction(ctx, testTenant)
	_, err = tx.Exec(ctx, "UPDATE ai_budget_accounts SET limit_micros=99999999 WHERE tenant_id=$1", testTenant)
	tx.Rollback(ctx)
	if err == nil {
		t.Fatal("runtime increased cap")
	}
	if err = b.ReapTenant(ctx, testTenant, 0); err != nil {
		t.Fatal(err)
	}
	if err = b.Settle(ctx, c, 0, 0, true); err != nil {
		t.Fatal(err)
	} // idempotent, no refund after full hold charged
	tx, _ = b.transaction(ctx, testTenant)
	defer tx.Rollback(ctx)
	var spent int64
	var known bool
	err = tx.QueryRow(ctx, "SELECT spent_micros,usage_known FROM ai_budget_attempts WHERE tenant_id=$1 AND id=$2", testTenant, id).Scan(&spent, &known)
	if err != nil || spent != 10 || known {
		t.Fatal("crash hold not conservatively charged", spent, known, err)
	}
}
func embedRequest(server *Server, token string, user string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/v1/embeddings", strings.NewReader(`{"tenant_id":"`+testTenant+`","model":"embed-v1","input":["test"],"input_type":"query"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	if user != "" {
		req.Header.Set("X-AI-Principal-ID", user)
	}
	out := httptest.NewRecorder()
	server.Handler().ServeHTTP(out, req)
	return out
}
func TestLiveControlledProviderRetriesBudgetsAndCircuit(t *testing.T) {
	c, _ := integrationControls(t)
	var calls atomic.Int64
	server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n == 1 {
			w.WriteHeader(503)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"usage": map[string]int{"total_tokens": 1}, "data": []any{map[string]any{"index": 0, "embedding": []float64{0.1}}}})
	})
	server.config.Controls = c
	for digest, caller := range server.config.TokenHashes {
		caller.TrustedUserContext = true
		server.config.TokenHashes[digest] = caller
	}
	out := embedRequest(server, token, testUser)
	if out.Code != 200 || calls.Load() != 2 {
		t.Fatal("retry failed", out.Code, out.Body.String(), calls.Load())
	}
	// Permanent authentication failure is never retried.
	fail, _ := testServer(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(401) })
	fail.config.Controls = c
	before := calls.Load()
	out = embedRequest(fail, token, "")
	if out.Code != 502 || calls.Load() != before+1 {
		t.Fatal("retried permanent error")
	}
	// 5xx failures open the process-local breaker and stop further egress.
	broken, _ := testServer(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(503) })
	broken.config.Controls = c
	out = embedRequest(broken, token, "")
	before = calls.Load()
	out = embedRequest(broken, token, "")
	if out.Code != 503 || calls.Load() != before {
		t.Fatal("open breaker allowed egress", out.Code)
	}
	time.Sleep(1050 * time.Millisecond)
	out = embedRequest(broken, token, "")
	if calls.Load() != before+1 {
		t.Fatal("half-open probe not bounded", calls.Load(), before)
	}
	// Per-attempt reservations are durable; unknown 5xx charges retained.
}
func TestLiveRedisOutageFailsClosed(t *testing.T) {
	c, _ := integrationControls(t)
	opts := &redis.Options{Addr: "127.0.0.1:1", MaxRetries: -1, DialTimeout: 50 * time.Millisecond, ReadTimeout: 50 * time.Millisecond, WriteTimeout: 50 * time.Millisecond}
	dead := redis.NewClient(opts)
	defer dead.Close()
	c.Admission.Client = dead
	var calls atomic.Int64
	server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	server.config.Controls = c
	out := embedRequest(server, token, "")
	if out.Code != 503 || calls.Load() != 0 {
		t.Fatal("Redis outage allowed provider call", out.Code)
	}
}
func TestUntrustedPrincipalRejected(t *testing.T) {
	var calls atomic.Int64
	server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	out := embedRequest(server, token, testUser)
	if out.Code != 403 || calls.Load() != 0 {
		t.Fatal("untrusted identity accepted")
	}
}
func TestBreakerAllowsOnlyOneProbe(t *testing.T) {
	b := circuitBreaker{states: map[string]*breakerState{}}
	b.finish("x", true, 1, time.Millisecond)
	time.Sleep(2 * time.Millisecond)
	var admitted atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if b.allow("x", time.Now()) {
				admitted.Add(1)
			}
		}()
	}
	wg.Wait()
	if admitted.Load() != 1 {
		t.Fatal(admitted.Load())
	}
	b.finish("x", false, 1, time.Second)
	if !b.allow("x", time.Now()) {
		t.Fatal("did not close")
	}
}

func TestLiveBudgetContentionDoesNotOverspend(t *testing.T) {
	_, b := integrationControls(t)
	var admitted atomic.Int64
	var wg sync.WaitGroup
	// Each attempt requests over half the dedicated tenant's cap. Exactly one
	// may hold it; concurrent NOWAIT conflicts are denied without overspending.
	tenant := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, _ := requestID()
			if b.Reserve(context.Background(), Charge{TenantID: tenant, ID: id, Model: "test", Provider: "test", Micros: 60, Tokens: 1}) == nil {
				admitted.Add(1)
			}
		}()
	}
	wg.Wait()
	if admitted.Load() != 1 {
		t.Fatalf("wanted one hold, got %d", admitted.Load())
	}
	if err := b.ReapTenant(context.Background(), tenant, 0); err != nil {
		t.Fatal(err)
	}
	tx, _ := b.transaction(context.Background(), tenant)
	defer tx.Rollback(context.Background())
	var held, spent int64
	if err := tx.QueryRow(context.Background(), "SELECT held_micros,spent_micros FROM ai_budget_accounts WHERE tenant_id=$1 AND scope='tenant'", tenant).Scan(&held, &spent); err != nil || held != 0 || spent != 60 {
		t.Fatal("cap not conserved", held, spent, err)
	}
}
func TestLiveProviderTimeoutAndFallback(t *testing.T) {
	c, b := integrationControls(t)
	c.AttemptTimeout = 40 * time.Millisecond
	c.Attempts = 1
	var calls atomic.Int64
	server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		select {
		case <-r.Context().Done():
		case <-time.After(150 * time.Millisecond):
		}
	})
	server.config.Controls = c
	before := time.Now()
	out := embedRequest(server, token, "")
	if out.Code != 502 || time.Since(before) > time.Second || calls.Load() != 1 {
		t.Fatal("attempt timeout not bounded", out.Code)
	}
	tx, _ := b.transaction(context.Background(), testTenant)
	var unknown int
	err := tx.QueryRow(context.Background(), "SELECT count(*) FROM ai_budget_attempts WHERE tenant_id=$1 AND usage_known=false AND state='settled'", testTenant).Scan(&unknown)
	tx.Rollback(context.Background())
	if err != nil || unknown < 1 {
		t.Fatal("unknown timeout not charged")
	}
	c.Attempts = 2
	c.AttemptTimeout = time.Second
	c.Fallbacks = map[string]string{"answer-provider": "fallback-provider"}
	var models []string
	fallback, _ := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		models = append(models, body.Model)
		if body.Model == "answer-provider" {
			w.WriteHeader(503)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"usage": map[string]int{"prompt_tokens": 1, "completion_tokens": 1}, "choices": []any{map[string]any{"message": map[string]string{"content": `{"answer":"Source","cited_chunk_ids":["c"]}`}}}})
	})
	fallback.config.Controls = c
	req := httptest.NewRequest("POST", "/v1/answers", strings.NewReader(`{"tenant_id":"`+testTenant+`","model":"answer-v1","question":"What?","context":[{"chunk_id":"c","text":"Source"}]}`))
	req.Header.Set("Authorization", "Bearer "+token)
	out = httptest.NewRecorder()
	fallback.Handler().ServeHTTP(out, req)
	if out.Code != 200 || len(models) != 2 || models[1] != "fallback-provider" {
		t.Fatal("fallback failed", out.Code, models)
	}
	tx, _ = b.transaction(context.Background(), testTenant)
	defer tx.Rollback(context.Background())
	var fallbackCount int
	err = tx.QueryRow(context.Background(), "SELECT count(*) FROM ai_budget_attempts WHERE tenant_id=$1 AND model='fallback-provider' AND state='settled'", testTenant).Scan(&fallbackCount)
	if err != nil || fallbackCount != 1 {
		t.Fatal("fallback hold missing")
	}
}
func TestLiveGlobalProviderLimitAndLeaseRelease(t *testing.T) {
	c, _ := integrationControls(t)
	c.Admission.Config.Provider["legacy"] = Limit{100, 100, 1}
	a := c.Admission
	ctx := context.Background()
	release, err := a.Acquire(ctx, Caller{TenantID: testTenant}, "query", "legacy", "global-first")
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.Acquire(ctx, Caller{TenantID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd"}, "query", "legacy", "global-second")
	if err == nil {
		t.Fatal("global provider capacity bypassed")
	}
	release()
	release, err = a.Acquire(ctx, Caller{TenantID: testTenant}, "query", "legacy", "global-third")
	if err != nil {
		t.Fatal("lease was not released", err)
	}
	release()
}

func TestRetryAfterIsNotShortened(t *testing.T) {
	if retryDelay(0, "30") < 30*time.Second {
		t.Fatal("provider Retry-After shortened")
	}
	if retryDelay(0, "999999999") > time.Hour {
		t.Fatal("unbounded retry delay")
	}
}
func TestGatewayAdmissionConfigValidation(t *testing.T) {
	client := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"})
	defer client.Close()
	a := &RedisAdmission{Client: client, Config: AdmissionConfig{Tenant: Limit{10, 1, 5}, Query: Limit{8, 1, 3}, Indexing: Limit{2, 1, 1}, User: Limit{2, 1, 1}, Provider: map[string]Limit{"legacy": {100, 10, 10}}, LeaseSeconds: 45}}
	if err := a.Validate(20 * time.Second); err != nil {
		t.Fatal(err)
	}
	a.Config.Provider["legacy"] = Limit{10, 1, 5}
	if a.Validate(20*time.Second) == nil {
		t.Fatal("tenant can exhaust provider")
	}
	a.Config.Provider["legacy"] = Limit{100, 10, 10}
	a.Config.LeaseSeconds = 5
	if a.Validate(20*time.Second) == nil {
		t.Fatal("lease too short")
	}
}

func TestLiveBudgetOutageDeniesEgress(t *testing.T) {
	c, _ := integrationControls(t)
	dead, err := pgxpool.New(context.Background(), "postgres://unused:unused@127.0.0.1:1/unused?sslmode=disable&connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	defer dead.Close()
	c.Budget = &PostgresBudget{Pool: dead}
	var calls atomic.Int64
	server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	server.config.Controls = c
	out := embedRequest(server, token, "")
	if out.Code != 503 || calls.Load() != 0 {
		t.Fatal("budget outage allowed egress", out.Code, calls.Load())
	}
}
func TestLiveCancellationDoesNotTripCircuit(t *testing.T) {
	c, _ := integrationControls(t)
	c.BreakerThreshold = 1
	server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) { time.Sleep(80 * time.Millisecond); w.WriteHeader(503) })
	server.config.Controls = c
	req := httptest.NewRequest("POST", "/v1/embeddings", strings.NewReader(`{"tenant_id":"`+testTenant+`","model":"embed-v1","input":["test"],"input_type":"query"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-AI-Timeout-Ms", "30")
	out := httptest.NewRecorder()
	server.Handler().ServeHTTP(out, req)
	if !server.breaker.allow(server.config.ProviderURL+":embed-provider", time.Now()) {
		t.Fatal("caller deadline opened provider circuit")
	}
}

func TestLiveStartupControlsAndRouteValidation(t *testing.T) {
	c, _ := integrationControls(t)
	cfg := ControlsFile{Admission: c.Admission.Config, Prices: c.Prices, Attempts: 2, AttemptTimeoutSeconds: 1, TotalTimeoutSeconds: 3, BreakerThreshold: 2, BreakerCooldownSeconds: 1}
	cfg.Admission.Provider = map[string]Limit{"legacy": {10000, 10000, 100}}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	file := t.TempDir() + "/controls.json"
	if err = os.WriteFile(file, raw, 0600); err != nil {
		t.Fatal(err)
	}
	controls, closeAll, err := OpenControls(context.Background(), file, os.Getenv("GATEWAY_TEST_REDIS_URL"), os.Getenv("GATEWAY_TEST_BUDGET_DSN"))
	if err != nil {
		t.Fatal(err)
	}
	defer closeAll()
	server, _ := testServer(t, func(w http.ResponseWriter, r *http.Request) {})
	server.config.Controls = controls
	for digest, caller := range server.config.TokenHashes {
		caller.TrustedUserContext = true
		server.config.TokenHashes[digest] = caller
	}
	if _, err = New(server.config); err != nil {
		t.Fatal("valid controls rejected", err)
	}
	controls.Fallbacks = map[string]string{"embed-provider": "fallback-provider"}
	if _, err = New(server.config); err == nil {
		t.Fatal("embedding fallback accepted")
	}
	controls.Fallbacks = nil
	for digest, caller := range server.config.TokenHashes {
		caller.TrustedUserContext = false
		server.config.TokenHashes[digest] = caller
	}
	if _, err = New(server.config); err == nil {
		t.Fatal("missing controlled user identity accepted")
	}
	if _, _, err = OpenControls(context.Background(), file, "redis://remote.example:6379", os.Getenv("GATEWAY_TEST_BUDGET_DSN")); err == nil {
		t.Fatal("insecure remote Redis accepted")
	}
}

func TestUsageKeepsInputAndOutputPricingSeparate(t *testing.T) {
	input, output, known := measuredUsage([]byte(`{"usage":{"prompt_tokens":5,"completion_tokens":10,"total_tokens":15}}`), false)
	if !known || input != 5 || output != 10 {
		t.Fatal("total masked output price")
	}
	input, output, known = measuredUsage([]byte(`{"usage":{"input_tokens":5,"output_tokens":10}}`), true)
	if !known || input != 5 || output != 10 {
		t.Fatal("Anthropic usage failed")
	}
	_, _, known = measuredUsage([]byte(`{"usage":{"total_tokens":-1}}`), false)
	if known {
		t.Fatal("negative usage accepted")
	}
}

func TestMalformedRequestsNeverReachProvider(t *testing.T) {
	var calls atomic.Int64
	server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	cases := []struct{ path, body string }{
		{"/v1/embeddings", `{"tenant_id":"` + testTenant + `","model":"embed-v1","input":[],"input_type":"query"}`},
		{"/v1/embeddings", `{"tenant_id":"` + testTenant + `","model":"embed-v1","input":[" "],"input_type":"query"}`},
		{"/v1/embeddings", `{"tenant_id":"` + testTenant + `","model":"embed-v1","input":["x"],"input_type":"bad"}`},
		{"/v1/embeddings", `{"tenant_id":"` + testTenant + `","model":"embed-v1","unknown":"x"}`},
		{"/v1/rerank", `{"tenant_id":"` + testTenant + `","model":"rerank-v1","query":"","documents":["x"],"top_n":1}`},
		{"/v1/rerank", `{"tenant_id":"` + testTenant + `","model":"rerank-v1","query":"x","documents":[" "],"top_n":1}`},
		{"/v1/rerank", `{"tenant_id":"` + testTenant + `","model":"unknown","query":"x","documents":["x"],"top_n":1}`},
		{"/v1/answers", `{"tenant_id":"` + testTenant + `","model":"answer-v1","question":"","context":[]}`},
		{"/v1/answers", `{"tenant_id":"` + testTenant + `","model":"unknown","question":"x","context":[{"chunk_id":"c","text":"x"}]}`},
		{"/v1/answers", `{"tenant_id":"` + testTenant + `","model":"answer-v1","question":"x","context":[{"chunk_id":"c","text":""}]}`},
		{"/v1/answers", `{"tenant_id":"` + testTenant + `","model":"answer-v1","question":"x","context":[{"chunk_id":"c","text":"x"},{"chunk_id":"c","text":"x"}]}`},
	}
	for _, c := range cases {
		req := httptest.NewRequest("POST", c.path, strings.NewReader(c.body))
		req.Header.Set("Authorization", "Bearer "+token)
		out := httptest.NewRecorder()
		server.Handler().ServeHTTP(out, req)
		if out.Code != 400 {
			t.Errorf("%s: %d", c.path, out.Code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid input reached provider")
	}
	req := httptest.NewRequest("POST", "/v1/embeddings", strings.NewReader("{}"))
	out := httptest.NewRecorder()
	server.Handler().ServeHTTP(out, req)
	if out.Code != 401 {
		t.Fatal("missing bearer accepted")
	}
	for _, path := range []string{"/healthz", "/readyz"} {
		req = httptest.NewRequest("GET", path, nil)
		out = httptest.NewRecorder()
		server.Handler().ServeHTTP(out, req)
		if out.Code != 200 {
			t.Fatal("readiness failed")
		}
		server.BeginDrain()
		out = httptest.NewRecorder()
		server.Handler().ServeHTTP(out, req)
		if out.Code != 503 {
			t.Fatal("drain readiness failed")
		}
		server.draining.Store(false)
	}
}
func TestProviderEmbeddingsAreValidated(t *testing.T) {
	for _, raw := range []string{`{"data":[{"index":1,"embedding":[1]}]}`, `{"data":[{"index":0,"embedding":[]}]}`, `{"data":[{"index":0,"embedding":[1]},{"index":1,"embedding":[1,2]}]}`} {
		server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(raw)) })
		input := `["x"]`
		if strings.Contains(raw, `"index":1,"embedding":[1,2]`) {
			input = `["x","y"]`
		}
		req := httptest.NewRequest("POST", "/v1/embeddings", strings.NewReader(`{"tenant_id":"`+testTenant+`","model":"embed-v1","input":`+input+`,"input_type":"query"}`))
		req.Header.Set("Authorization", "Bearer "+token)
		out := httptest.NewRecorder()
		server.Handler().ServeHTTP(out, req)
		if out.Code != 502 {
			t.Fatal("invalid embedding accepted", out.Code)
		}
	}
}
