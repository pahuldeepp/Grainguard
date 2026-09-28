package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

type apiFixture struct {
	t        *testing.T
	issuer   *testIssuer
	app      App
	srv      *httptest.Server
	client   *http.Client
	exporter *tracetest.InMemoryExporter
}

func apiRoomyLimits() LimitConfig {
	return LimitConfig{Device: BucketConfig{Rate: 1000, Burst: 1000}, Tenant: BucketConfig{Rate: 1000, Burst: 1000}, MaxEntries: 1000}
}

func newAPIFixture(t *testing.T, limits LimitConfig, tracing bool) *apiFixture {
	t.Helper()
	db := pooled(t, 8)
	issuer := newTestIssuer(t)
	metrics := NewMetrics()
	app := App{
		Ping:     func(context.Context) error { return nil },
		Verifier: issuer.verifier(t),
		Ingestor: NewIngestor(db, QualityPolicy{}, nil),
		Limiter:  NewTokenBuckets(limits, nil),
		Recorder: NewRejectionRecorder(db, metrics, nil),
		Metrics:  metrics,
	}
	f := &apiFixture{t: t, issuer: issuer, app: app}
	if tracing {
		f.exporter = tracetest.NewInMemoryExporter()
		tr, err := InitTracing(TracingConfig{ServiceName: "api-test", SampleRatio: 1, Exporter: f.exporter})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = tr.Shutdown(context.Background()) })
		f.app.Tracing = tr
	}
	f.srv = httptest.NewServer(newHandler(f.app))
	t.Cleanup(f.srv.Close)
	f.client = &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	return f
}

func (f *apiFixture) token(tenant, sub string, roles ...string) string {
	return f.issuer.sign(map[string]any{"tenant_id": tenant, "sub": sub, "roles": roles})
}

func (f *apiFixture) do(method, path, token, body string, headers map[string]string) (*http.Response, []byte) {
	f.t.Helper()
	req, err := http.NewRequest(method, f.srv.URL+path, strings.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := f.client.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

func (f *apiFixture) post(token, device, body string) (*http.Response, []byte) {
	return f.do("POST", "/v1/devices/"+device+"/readings", token, body, nil)
}

func (f *apiFixture) metric(line string) bool {
	_, data := f.do("GET", "/metrics", "", "", nil)
	return strings.Contains(string(data), line+"\n")
}

func apiBody(source string, temperature any) string {
	return fmt.Sprintf(`{"source_message_id":%q,"observed_at":%q,"temperature_c":%v}`,
		source, time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano), temperature)
}

func apiBoundDevice(t *testing.T) (tenant, device string) {
	t.Helper()
	tenant, device = randomUUID(), randomUUID()
	mustApply(t, pooled(t, 2), eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1}, BindingApplied)
	return tenant, device
}

func apiProblem(t *testing.T, resp *http.Response, data []byte, status int, code string) problemBody {
	t.Helper()
	var p problemBody
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatalf("not JSON: %s", data)
	}
	if resp.StatusCode != status || p.Code != code || p.Status != status {
		t.Fatalf("got %d %s (%s), want %d %s", resp.StatusCode, p.Code, data, status, code)
	}
	if ct := resp.Header.Get("Content-Type"); ct != contentTypeProblem {
		t.Fatalf("content type %q", ct)
	}
	if p.CorrelationID == "" || p.CorrelationID != resp.Header.Get("X-Correlation-Id") {
		t.Fatalf("problem correlation %q vs header %q", p.CorrelationID, resp.Header.Get("X-Correlation-Id"))
	}
	return p
}

func apiCount(t *testing.T, sql string, args ...any) int { return adminInt(t, sql, args...) }

func TestAnOperatorStoresAReadingAndARetryReturnsTheSameAcknowledgement(t *testing.T) {
	f := newAPIFixture(t, apiRoomyLimits(), false)
	tenant, device := apiBoundDevice(t)
	token := f.token(tenant, "operator-1", RoleOperator)
	body := apiBody("m-1", 21.5)
	resp, data := f.post(token, device, body)
	if resp.StatusCode != http.StatusAccepted || resp.Header.Get("Content-Type") != contentTypeJSON {
		t.Fatalf("got %d %s", resp.StatusCode, data)
	}
	var first IngestResult
	if err := json.Unmarshal(data, &first); err != nil || first.Status != "stored" || first.StreamVersion != "1" || first.ProjectionStatus != "pending" {
		t.Fatalf("acknowledgement: %+v %v", first, err)
	}
	if resp.Header.Get("X-Correlation-Id") == "" {
		t.Fatal("responses carry a correlation id")
	}
	_, again := f.post(token, device, body)
	var second IngestResult
	_ = json.Unmarshal(again, &second)
	if second != first {
		t.Fatalf("retry differs: %+v vs %+v", second, first)
	}
	if n := apiCount(t, "SELECT count(*) FROM readings WHERE device_id = $1", device); n != 1 {
		t.Fatalf("readings: %d", n)
	}
	if !f.metric("ingest_readings_accepted_total 2") {
		t.Fatal("both acknowledged requests are counted")
	}
	changed := apiBody("m-1", 30)
	resp, data = f.post(token, device, changed)
	apiProblem(t, resp, data, http.StatusConflict, ReasonIdempotencyConflict)
}

func TestADeviceTokenMayOnlyWriteItsOwnReadings(t *testing.T) {
	f := newAPIFixture(t, apiRoomyLimits(), false)
	tenant, device := apiBoundDevice(t)
	_, other := apiBoundDeviceIn(t, tenant)
	deviceToken := f.token(tenant, device, RoleDevice)
	if resp, data := f.post(deviceToken, device, apiBody("d-1", 20)); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("own device: %d %s", resp.StatusCode, data)
	}
	resp, data := f.post(deviceToken, other, apiBody("d-2", 20))
	apiProblem(t, resp, data, http.StatusForbidden, ReasonDeviceForbidden)
	viewer := f.token(tenant, "viewer-1", RoleViewer)
	resp, data = f.post(viewer, device, apiBody("v-1", 20))
	apiProblem(t, resp, data, http.StatusForbidden, ReasonDeviceForbidden)
}

func apiBoundDeviceIn(t *testing.T, tenant string) (string, string) {
	t.Helper()
	device := randomUUID()
	mustApply(t, pooled(t, 2), eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1}, BindingApplied)
	return tenant, device
}

func TestTenantIsolationOverHTTP(t *testing.T) {
	f := newAPIFixture(t, apiRoomyLimits(), false)
	tenantA, deviceA := apiBoundDevice(t)
	tenantB := randomUUID()
	tokenB := f.token(tenantB, "operator-b", RoleOperator)
	resp, data := f.post(tokenB, deviceA, apiBody("x-1", 20))
	apiProblem(t, resp, data, http.StatusConflict, ReasonDeviceNotReady)
	forged := map[string]string{"X-Tenant-Id": tenantA}
	resp, data = f.do("POST", "/v1/devices/"+deviceA+"/readings", tokenB, apiBody("x-2", 20), forged)
	apiProblem(t, resp, data, http.StatusConflict, ReasonDeviceNotReady)
	if n := apiCount(t, "SELECT count(*) FROM readings WHERE device_id = $1", deviceA); n != 0 {
		t.Fatalf("tenant B wrote %d readings into tenant A", n)
	}
	if resp, _ := f.post(f.token(tenantA, "operator-a", RoleOperator), deviceA, apiBody("a-1", 20)); resp.StatusCode != http.StatusAccepted {
		t.Fatal("the owning tenant can still write")
	}
}

func TestEveryAuthenticationFailureIsAProblemWithTheRightStatus(t *testing.T) {
	f := newAPIFixture(t, apiRoomyLimits(), false)
	tenant, device := apiBoundDevice(t)
	expired := f.issuer.sign(map[string]any{"tenant_id": tenant, "roles": []string{RoleOperator}, "exp": time.Now().Add(-time.Hour).Unix()})
	noTenant := f.issuer.sign(map[string]any{"tenant_id": nil})
	for name, tc := range map[string]struct{ token, code string }{
		"no token":  {"", "missing_token"},
		"garbage":   {"garbage", "invalid_token"},
		"expired":   {expired, "expired_token"},
		"no tenant": {noTenant, "invalid_claims"},
	} {
		resp, data := f.post(tc.token, device, apiBody("a-1", 20))
		apiProblem(t, resp, data, http.StatusUnauthorized, tc.code)
		if resp.Header.Get("WWW-Authenticate") != "Bearer" {
			t.Errorf("%s: missing WWW-Authenticate", name)
		}
	}
	if n := apiCount(t, "SELECT count(*) FROM readings WHERE device_id = $1", device); n != 0 {
		t.Fatalf("an unauthenticated request stored %d readings", n)
	}
}

func TestAnUnreachableKeyServerIs503WithRetryAfter(t *testing.T) {
	f := newAPIFixture(t, apiRoomyLimits(), false)
	cfg := f.issuer.config()
	cfg.JWKSURL = "http://127.0.0.1:1/jwks"
	verifier, err := NewVerifier(cfg)
	if err != nil {
		t.Fatal(err)
	}
	app := f.app
	app.Verifier = verifier
	srv := httptest.NewServer(newHandler(app))
	defer srv.Close()
	req, _ := http.NewRequest("POST", srv.URL+"/v1/devices/"+randomUUID()+"/readings", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+f.issuer.sign(nil))
	resp, err := f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	apiProblem(t, resp, data, http.StatusServiceUnavailable, "auth_unavailable")
	if resp.Header.Get("Retry-After") != "5" {
		t.Fatalf("Retry-After %q", resp.Header.Get("Retry-After"))
	}
}

func TestRejectionsReturnStableReasonsStoreNothingAndAreCounted(t *testing.T) {
	f := newAPIFixture(t, apiRoomyLimits(), false)
	tenant, device := apiBoundDevice(t)
	token := f.token(tenant, "operator-1", RoleOperator)
	at := func(d time.Duration) string { return time.Now().UTC().Add(d).Format(time.RFC3339Nano) }
	cases := []struct {
		name, body, reason string
		status             int
	}{
		{"not json", `{`, ReasonInvalidBody, 400},
		{"unknown field", `{"source_message_id":"m-1","observed_at":"` + at(-time.Minute) + `","temperature_c":20,"x":1}`, ReasonInvalidBody, 400},
		{"missing timestamp", `{"source_message_id":"m-1","temperature_c":20}`, ReasonInvalidField, 400},
		{"bad source id", apiBody("!bad", 20), ReasonInvalidField, 400},
		{"no measurements", `{"source_message_id":"m-1","observed_at":"` + at(-time.Minute) + `"}`, ReasonNoMeasurements, 422},
		{"out of range", apiBody("m-1", 500), ReasonValueOutOfRange, 422},
		{"not finite", apiBody("m-1", "1e999"), ReasonNonFiniteValue, 422},
		{"future", `{"source_message_id":"m-1","observed_at":"` + at(time.Hour) + `","temperature_c":20}`, ReasonTimestampInFuture, 422},
		{"too old", `{"source_message_id":"m-1","observed_at":"` + at(-30*24*time.Hour) + `","temperature_c":20}`, ReasonTimestampTooOld, 422},
		{"too large", `{"source_message_id":"m-1","observed_at":"` + at(-time.Minute) + `","pad":"` + strings.Repeat("x", 17<<10) + `"}`, ReasonInvalidBody, 400},
	}
	seen := map[string]int{}
	for _, tc := range cases {
		resp, data := f.post(token, device, tc.body)
		p := apiProblem(t, resp, data, tc.status, tc.reason)
		if strings.Contains(string(data), "xxxx") || strings.Contains(p.Detail, "secret") {
			t.Errorf("%s: the response echoes the payload", tc.name)
		}
		seen[tc.reason]++
		if !f.metric(fmt.Sprintf("ingest_rejections_total{reason=%q} %d", tc.reason, seen[tc.reason])) {
			t.Errorf("%s: the counter for %s is not at %d", tc.name, tc.reason, seen[tc.reason])
		}
	}
	resp, data := f.post(token, "not-a-uuid", apiBody("m-1", 20))
	apiProblem(t, resp, data, http.StatusBadRequest, ReasonInvalidField)
	for _, table := range []string{"readings", "outbox_events", "ingest_receipts"} {
		if n := apiCount(t, "SELECT count(*) FROM "+table+" WHERE tenant_id = $1", tenant); n != 0 {
			t.Fatalf("%s: %d rows after only rejections", table, n)
		}
	}
	if n := apiCount(t, "SELECT count(*) FROM ingest_rejection_samples WHERE device_id = $1", device); n < 1 || n > 20 {
		t.Fatalf("rejection samples: %d, want between 1 and 20", n)
	}
}

func TestUnboundAndDisabledDevicesAreRefused(t *testing.T) {
	f := newAPIFixture(t, apiRoomyLimits(), false)
	tenant, device := apiBoundDevice(t)
	token := f.token(tenant, "operator-1", RoleOperator)
	resp, data := f.post(token, randomUUID(), apiBody("m-1", 20))
	apiProblem(t, resp, data, http.StatusConflict, ReasonDeviceNotReady)
	if _, err := fixtureAdminExec(t, adminConn(t, "greenguard_telemetry"), tenant,
		"UPDATE device_bindings SET status = 'disabled' WHERE device_id = $1", device); err != nil {
		t.Fatal(err)
	}
	resp, data = f.post(token, device, apiBody("m-2", 20))
	apiProblem(t, resp, data, http.StatusForbidden, ReasonDeviceDisabled)
}

func TestTheRateLimiterThrottlesBurstsWithRetryAfterAndWritesNothing(t *testing.T) {
	limits := apiRoomyLimits()
	limits.Device = BucketConfig{Rate: 0.0001, Burst: 3}
	f := newAPIFixture(t, limits, false)
	tenant, device := apiBoundDevice(t)
	_, quiet := apiBoundDeviceIn(t, tenant)
	token := f.token(tenant, "operator-1", RoleOperator)
	for i := 1; i <= 3; i++ {
		if resp, data := f.post(token, device, apiBody(fmt.Sprintf("m-%d", i), 20)); resp.StatusCode != http.StatusAccepted {
			t.Fatalf("burst request %d: %d %s", i, resp.StatusCode, data)
		}
	}
	resp, data := f.post(token, device, apiBody("m-4", 20))
	apiProblem(t, resp, data, http.StatusTooManyRequests, ReasonRateLimited)
	if retry := resp.Header.Get("Retry-After"); retry == "" || retry == "0" {
		t.Fatalf("Retry-After %q", retry)
	}
	if !f.metric(`ingest_rejections_total{reason="rate_limited"} 1`) {
		t.Fatal("a throttled request is counted")
	}
	if n := apiCount(t, "SELECT count(*) FROM readings WHERE device_id = $1", device); n != 3 {
		t.Fatalf("readings: %d", n)
	}
	if n := apiCount(t, "SELECT count(*) FROM ingest_rejection_samples WHERE device_id = $1", device); n != 0 {
		t.Fatalf("throttling must not write rejection samples, found %d", n)
	}
	if resp, _ := f.post(token, quiet, apiBody("q-1", 20)); resp.StatusCode != http.StatusAccepted {
		t.Fatal("another device of the same tenant must not be throttled")
	}
}

func TestADeviceCannotSpendAnotherDevicesBucketThroughAForgedPath(t *testing.T) {
	limits := apiRoomyLimits()
	limits.Device = BucketConfig{Rate: 0.0001, Burst: 2}
	f := newAPIFixture(t, limits, false)
	tenant, attacker := apiBoundDevice(t)
	_, victim := apiBoundDeviceIn(t, tenant)
	attackerToken := f.token(tenant, attacker, RoleDevice)
	statuses := []int{}
	for i := 0; i < 4; i++ {
		resp, _ := f.post(attackerToken, victim, apiBody(fmt.Sprintf("f-%d", i), 20))
		statuses = append(statuses, resp.StatusCode)
	}
	if fmt.Sprint(statuses) != "[403 403 429 429]" {
		t.Fatalf("attacker statuses %v: the attacker's own bucket must run out", statuses)
	}
	operator := f.token(tenant, "operator-1", RoleOperator)
	if resp, data := f.post(operator, victim, apiBody("v-1", 20)); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("the victim's bucket was drained: %d %s", resp.StatusCode, data)
	}
}

func TestTheTenantBucketThrottlesAcrossDevices(t *testing.T) {
	limits := apiRoomyLimits()
	limits.Tenant = BucketConfig{Rate: 0.0001, Burst: 2}
	f := newAPIFixture(t, limits, false)
	tenant, first := apiBoundDevice(t)
	_, second := apiBoundDeviceIn(t, tenant)
	token := f.token(tenant, "operator-1", RoleOperator)
	f.post(token, first, apiBody("a-1", 20))
	f.post(token, second, apiBody("b-1", 20))
	resp, data := f.post(token, first, apiBody("a-2", 20))
	apiProblem(t, resp, data, http.StatusTooManyRequests, ReasonRateLimited)
}

// apiStoredTrace returns the traceparent and correlation id stored on the outbox event of a reading.
func apiStoredTrace(t *testing.T, device, source string) (traceparent, correlation string) {
	t.Helper()
	err := adminConn(t, "greenguard_telemetry").QueryRow(context.Background(),
		`SELECT o.traceparent, o.correlation_id::text FROM outbox_events o JOIN readings r
		   ON r.tenant_id = o.tenant_id AND r.device_id = o.aggregate_id AND r.stream_version = o.aggregate_version
		  WHERE r.device_id = $1 AND r.source_message_id = $2`, device, source).Scan(&traceparent, &correlation)
	if err != nil {
		t.Fatal(err)
	}
	return traceparent, correlation
}

func TestTheStoredTraceparentIsTheRequestsServerSpan(t *testing.T) {
	f := newAPIFixture(t, apiRoomyLimits(), true)
	tenant, device := apiBoundDevice(t)
	token := f.token(tenant, "operator-1", RoleOperator)
	const traceID, callerSpan = "4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"
	for _, flags := range []string{"01", "00"} {
		f.exporter.Reset()
		source := "t-" + flags
		resp, data := f.do("POST", "/v1/devices/"+device+"/readings", token, apiBody(source, 20),
			map[string]string{"traceparent": "00-" + traceID + "-" + callerSpan + "-" + flags})
		if resp.StatusCode != http.StatusAccepted {
			t.Fatalf("%d %s", resp.StatusCode, data)
		}
		stored, correlation := apiStoredTrace(t, device, source)
		if correlation != resp.Header.Get("X-Correlation-Id") {
			t.Fatalf("stored correlation %s vs response %s", correlation, resp.Header.Get("X-Correlation-Id"))
		}
		if !strings.HasPrefix(stored, "00-"+traceID+"-") || !strings.HasSuffix(stored, "-"+flags) || strings.Contains(stored, callerSpan) {
			t.Fatalf("stored traceparent %q must continue the trace with a new span and flags %s", stored, flags)
		}
		if flags == "01" {
			apiAssertSpanMatches(t, f.exporter, stored, traceID)
		}
	}
}

func apiAssertSpanMatches(t *testing.T, exporter *tracetest.InMemoryExporter, stored, traceID string) {
	t.Helper()
	spans := exporter.GetSpans()
	if len(spans) != 1 || spans[0].Name != "POST /v1/devices/:id/readings" ||
		stored != "00-"+traceID+"-"+spans[0].SpanContext.SpanID().String()+"-01" {
		t.Fatalf("exported spans %+v do not match the stored traceparent %s", spans, stored)
	}
}

func TestMetricsAndHealthExistWithoutAuthenticationConfigured(t *testing.T) {
	h := newHandler(App{Ping: func(context.Context) error { return nil }})
	for _, target := range []string{"POST /v1/devices/" + randomUUID() + "/readings", "GET /nope"} {
		parts := strings.SplitN(target, " ", 2)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(parts[0], parts[1], nil))
		if w.Code != http.StatusNotFound || w.Header().Get("Content-Type") != contentTypeProblem {
			t.Errorf("%s: %d %s", target, w.Code, w.Header().Get("Content-Type"))
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "# HELP http_server_requests_total") {
		t.Fatalf("metrics must remain scrapeable without API auth: %d %s", w.Code, w.Body.String())
	}
}

type apiErrReader struct{}

func (apiErrReader) Read([]byte) (int, error) { return 0, errors.New("connection reset") }

func TestAnUnreadableBodyIsARejectionAndADatabaseFailureIs500WithoutDetail(t *testing.T) {
	f := newAPIFixture(t, apiRoomyLimits(), false)
	tenant, device := apiBoundDevice(t)
	token := f.token(tenant, "operator-1", RoleOperator)
	h := newHandler(f.app)
	req := httptest.NewRequest("POST", "/v1/devices/"+device+"/readings", io.NopCloser(apiErrReader{}))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	apiProblem(t, w.Result(), w.Body.Bytes(), http.StatusBadRequest, ReasonInvalidBody)

	broken := f.app
	broken.Ingestor = NewIngestor(failingDB{}, QualityPolicy{}, nil)
	req = httptest.NewRequest("POST", "/v1/devices/"+device+"/readings", strings.NewReader(apiBody("m-1", 20)))
	req.Header.Set("Authorization", "Bearer "+token)
	w = httptest.NewRecorder()
	newHandler(broken).ServeHTTP(w, req)
	apiProblem(t, w.Result(), w.Body.Bytes(), http.StatusInternalServerError, codeInternal)
	if strings.Contains(w.Body.String(), "database unavailable") {
		t.Fatal("a 500 must not leak the cause")
	}
}

func TestWriteAuthErrorHandlesEveryStatus(t *testing.T) {
	for name, tc := range map[string]struct {
		err    error
		status int
		code   string
	}{
		"forbidden":         {&AuthError{Status: http.StatusForbidden, Code: "insufficient_role"}, 403, "insufficient_role"},
		"not an auth error": {errors.New("boom"), 500, codeInternal},
	} {
		w := httptest.NewRecorder()
		writeAuthError(w, httptest.NewRequest("GET", "/", nil), tc.err)
		var p problemBody
		_ = json.Unmarshal(w.Body.Bytes(), &p)
		if w.Code != tc.status || p.Code != tc.code {
			t.Errorf("%s: %d %s", name, w.Code, p.Code)
		}
	}
}

func TestAnInvalidPathDeviceIdNeverCreatesLimiterState(t *testing.T) {
	f := newAPIFixture(t, apiRoomyLimits(), false)
	limiter := f.app.Limiter.(*TokenBuckets)
	tenant := randomUUID()
	token := f.token(tenant, "operator-1", RoleOperator)
	before := len(limiter.devices.items)
	for _, id := range []string{"not-a-uuid", "..%2f..", strings.Repeat("a", 200), "00000000-0000-0000-0000-000000000000"} {
		resp, data := f.post(token, id, apiBody("m-1", 20))
		apiProblem(t, resp, data, http.StatusBadRequest, ReasonInvalidField)
	}
	if after := len(limiter.devices.items); after != before {
		t.Fatalf("invalid device ids created %d limiter buckets", after-before)
	}
	if len(limiter.tenants.items) != 0 {
		t.Fatal("a rejected path must not touch the tenant bucket either")
	}
}

func TestUnknownRotatedKeyDuringOutageReturnsRetryAfter(t *testing.T) {
	f := newAPIFixture(t, apiRoomyLimits(), false)
	if _, err := f.app.Verifier.Verify(authBearer + f.issuer.sign(nil)); err != nil {
		t.Fatal(err)
	}
	f.issuer.rotate()
	token := f.issuer.sign(nil)
	f.issuer.set(func() { f.issuer.status = http.StatusServiceUnavailable })
	time.Sleep(80 * time.Millisecond)
	resp, data := f.post(token, randomUUID(), "{}")
	apiProblem(t, resp, data, http.StatusServiceUnavailable, codeUnavailable)
	if resp.Header.Get("Retry-After") != "5" {
		t.Fatalf("missing retry guidance: %v", resp.Header)
	}
	f.issuer.set(func() { f.issuer.status = http.StatusOK; f.issuer.keys = nil })
	time.Sleep(80 * time.Millisecond)
	resp, data = f.post(token, randomUUID(), "{}")
	apiProblem(t, resp, data, http.StatusUnauthorized, codeInvalidToken)
}
