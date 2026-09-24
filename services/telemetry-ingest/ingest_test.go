package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

const (
	ingTraceparent  = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	ingTelemetryDB  = "greenguard_telemetry"
	ingCountsFormat = "counts %v"
)

type ingFixture struct {
	t              *testing.T
	db             TxStarter
	ingestor       *Ingestor
	tenant, device string
	site, bin      string
}

func ingMeta() RequestMeta {
	return RequestMeta{CorrelationID: randomUUID(), Traceparent: ingTraceparent}
}

func ingNewIngestor(db TxStarter) *Ingestor {
	return NewIngestor(db, QualityPolicy{}, func() time.Time { return ingNow })
}

func ingBinding(t *testing.T, db TxStarter, tenant string) (device, site, bin string) {
	t.Helper()
	device, site, bin = randomUUID(), randomUUID(), randomUUID()
	mustApply(t, db, eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1, site: site, bin: bin}, BindingApplied)
	return device, site, bin
}

func ingSetup(t *testing.T) ingFixture {
	t.Helper()
	db := pooled(t, 8)
	tenant := randomUUID()
	device, site, bin := ingBinding(t, db, tenant)
	return ingFixture{t: t, db: db, ingestor: ingNewIngestor(db), tenant: tenant, device: device, site: site, bin: bin}
}

func (f ingFixture) principal() Principal {
	return Principal{Subject: f.device, TenantID: f.tenant, Roles: []string{RoleDevice}}
}

func (f ingFixture) ingest(id, extra string) (IngestResult, error) {
	body := `{"source_message_id":"` + id + `","observed_at":"2026-09-21T14:59:59.5Z"` + extra + `}`
	return f.ingestor.Ingest(context.Background(), f.principal(), f.device, []byte(body), ingMeta())
}

func (f ingFixture) count(table string) int {
	return adminInt(f.t, "SELECT count(*) FROM "+table+" WHERE tenant_id = $1", f.tenant)
}

func ingCounts(t *testing.T, f ingFixture) [5]int {
	t.Helper()
	return [5]int{f.count("readings"), f.count("outbox_events"), f.count("audit_events"), f.count("ingest_receipts"),
		adminInt(t, "SELECT last_version FROM device_streams WHERE tenant_id = $1", f.tenant)}
}

func ingMustReject(t *testing.T, err error, reason string, status int) {
	t.Helper()
	var rej *Rejection
	if !errors.As(err, &rej) || rej.Reason != reason || rej.Status != status {
		t.Fatalf("want %s/%d, got %v", reason, status, err)
	}
}

func TestIngestStoresOneReadingEventAuditAndReceiptWithMatchingIDs(t *testing.T) {
	f := ingSetup(t)
	result, err := f.ingest("msg-1", `,"temperature_c":21.5,"relative_humidity_percent":55`)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "stored" || result.StreamVersion != "1" || result.ProjectionStatus != "pending" {
		t.Fatalf("%+v", result)
	}
	if got := ingCounts(t, f); got != [5]int{1, 1, 1, 1, 1} {
		t.Fatalf(ingCountsFormat, got)
	}
	admin := adminConn(t, ingTelemetryDB)
	var site, binID, receiptEvent, receiptReading, auditActor, auditAction string
	if err := admin.QueryRow(context.Background(),
		`SELECT r.site_id::text, r.bin_id::text, c.event_id::text, c.reading_id::text, a.actor_type || ':' || a.actor_id, a.action
		 FROM readings r JOIN ingest_receipts c USING (tenant_id, reading_id)
		 JOIN audit_events a ON a.resource_id = r.reading_id AND a.event_id = c.event_id AND a.command_id = c.command_id AND a.outcome = 'succeeded'
		 WHERE r.reading_id = $1`, result.ReadingID).Scan(&site, &binID, &receiptEvent, &receiptReading, &auditActor, &auditAction); err != nil {
		t.Fatal(err)
	}
	if site != f.site || binID != f.bin || receiptEvent != result.EventID || receiptReading != result.ReadingID ||
		auditActor != "device:"+f.device || auditAction != "reading.record" {
		t.Fatalf("mismatch: %s %s %s %s %s", site, binID, receiptEvent, receiptReading, auditActor)
	}
	ingCheckEvent(t, admin, f, result)
}

func ingLoadEvent(t *testing.T, admin *pgx.Conn, eventID string) []byte {
	t.Helper()
	var doc []byte
	if err := admin.QueryRow(context.Background(),
		`SELECT jsonb_build_object('event_id', event_id, 'event_type', event_type, 'schema_version', schema_version,
		   'occurred_at', to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		   'tenant_id', tenant_id, 'aggregate_type', aggregate_type, 'aggregate_id', aggregate_id,
		   'aggregate_version', aggregate_version::text, 'correlation_id', correlation_id, 'causation_id', causation_id,
		   'traceparent', traceparent, 'payload', payload)::text
		 FROM outbox_events WHERE event_id = $1`, eventID).Scan(&doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func ingCompileSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	raw, err := os.ReadFile("../../contracts/events/telemetry-recorded.v1.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	const id = "urn:greenguard:contracts:events:telemetry-recorded:v1"
	if err := c.AddResource(id, doc); err != nil {
		t.Fatal(err)
	}
	schema, err := c.Compile(id)
	if err != nil {
		t.Fatal(err)
	}
	return schema
}

type ingEvent struct {
	EventID          string           `json:"event_id"`
	OccurredAt       string           `json:"occurred_at"`
	TenantID         string           `json:"tenant_id"`
	AggregateID      string           `json:"aggregate_id"`
	AggregateVersion string           `json:"aggregate_version"`
	CorrelationID    string           `json:"correlation_id"`
	CausationID      string           `json:"causation_id"`
	Traceparent      string           `json:"traceparent"`
	Payload          telemetryPayload `json:"payload"`
}

func ingCheckEvent(t *testing.T, admin *pgx.Conn, f ingFixture, result IngestResult) {
	t.Helper()
	raw := ingLoadEvent(t, admin, result.EventID)
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if err := ingCompileSchema(t).Validate(instance); err != nil {
		t.Fatalf("event violates the contract: %v\n%s", err, raw)
	}
	var event ingEvent
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatal(err)
	}
	if event.AggregateVersion != result.StreamVersion || event.AggregateID != f.device || event.TenantID != f.tenant ||
		event.Traceparent != ingTraceparent || event.Payload.ReadingID != result.ReadingID {
		t.Fatalf("envelope %+v", event)
	}
	fraction := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$`)
	for _, ts := range []string{event.OccurredAt, event.Payload.ObservedAt, event.Payload.ReceivedAt} {
		if !fraction.MatchString(ts) {
			t.Errorf("timestamp %q lacks six fractional digits", ts)
		}
	}
	if event.Payload.ObservedAt != "2026-09-21T14:59:59.500000Z" || event.Payload.ReceivedAt != "2026-09-21T15:00:00.123456Z" {
		t.Errorf("payload times %s %s", event.Payload.ObservedAt, event.Payload.ReceivedAt)
	}
	lower := regexp.MustCompile(`^[0-9a-f-]{36}$`)
	for _, id := range []string{event.EventID, event.CorrelationID, event.CausationID, result.ReadingID} {
		if !lower.MatchString(id) || !isUUID(id) {
			t.Errorf("id %q is not a lowercase v4 UUID", id)
		}
	}
	if event.Payload.BindingVersion != "1" || event.Payload.BinID == nil || *event.Payload.BinID != f.bin || event.Payload.SiteID != f.site {
		t.Errorf("binding data %+v", event.Payload)
	}
}

func TestIngestOmitsAbsentMeasurementsAndNeverWritesZero(t *testing.T) {
	f := ingSetup(t)
	result, err := f.ingest("msg-h", `,"temperature_c":null,"relative_humidity_percent":40`)
	if err != nil {
		t.Fatal(err)
	}
	raw := ingLoadEvent(t, adminConn(t, ingTelemetryDB), result.EventID)
	if strings.Contains(string(raw), "temperature_c") {
		t.Fatalf("absent measurement leaked into the event: %s", raw)
	}
	if n := adminInt(t, "SELECT count(*) FROM readings WHERE reading_id = $1 AND temperature_c IS NULL AND relative_humidity_percent = 40", result.ReadingID); n != 1 {
		t.Fatal("temperature must be NULL, not zero")
	}
}

func TestIngestRetryReturnsTheStoredResultAndCreatesNothing(t *testing.T) {
	f := ingSetup(t)
	first, err := f.ingest("msg-r", `,"temperature_c":10`)
	if err != nil {
		t.Fatal(err)
	}
	f.ingestor.now = func() time.Time { return ingNow.Add(time.Minute) }
	again, err := f.ingest("msg-r", `,"temperature_c":10.0`)
	if err != nil || again != first {
		t.Fatalf("retry: %+v %v, first %+v", again, err, first)
	}
	if got := ingCounts(t, f); got != [5]int{1, 1, 1, 1, 1} {
		t.Fatalf(ingCountsFormat, got)
	}
}

func TestIngestSameMessageWithDifferentContentConflictsAndKeepsTheOriginal(t *testing.T) {
	f := ingSetup(t)
	first, err := f.ingest("msg-c", `,"temperature_c":10`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.ingest("msg-c", `,"temperature_c":11`)
	ingMustReject(t, err, ReasonIdempotencyConflict, 409)
	if n := adminInt(t, "SELECT count(*) FROM readings WHERE reading_id = $1 AND temperature_c = 10", first.ReadingID); n != 1 {
		t.Fatal("the original reading must stay")
	}
	if got := ingCounts(t, f); got != [5]int{1, 1, 1, 1, 1} {
		t.Fatalf(ingCountsFormat, got)
	}
}

func TestTwentyConcurrentIdenticalRequestsStoreOneReading(t *testing.T) {
	f := ingSetup(t)
	results := make([]IngestResult, 20)
	errs := make([]error, 20)
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], errs[i] = f.ingest("msg-x", `,"temperature_c":3`)
		}()
	}
	wg.Wait()
	for i := range results {
		if errs[i] != nil || results[i] != results[0] {
			t.Fatalf("request %d: %+v %v", i, results[i], errs[i])
		}
	}
	if got := ingCounts(t, f); got != [5]int{1, 1, 1, 1, 1} {
		t.Fatalf(ingCountsFormat, got)
	}
}

func TestConcurrentDistinctReadingsGetGaplessVersionsAndOtherDevicesProgressIndependently(t *testing.T) {
	f := ingSetup(t)
	other, _, _ := ingBinding(t, f.db, f.tenant)
	const n = 25
	versions := make([]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var r IngestResult
			r, errs[i] = f.ingest(fmt.Sprintf("d-%d", i), `,"temperature_c":1`)
			versions[i] = r.StreamVersion
		}()
	}
	wg.Wait()
	nums := make([]int, n)
	for i := range versions {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		fmt.Sscan(versions[i], &nums[i])
	}
	sort.Ints(nums)
	for i, v := range nums {
		if v != i+1 {
			t.Fatalf("versions %v", nums)
		}
	}
	p := Principal{Subject: other, TenantID: f.tenant, Roles: []string{RoleDevice}}
	r, err := f.ingestor.Ingest(context.Background(), p, other,
		[]byte(`{"source_message_id":"o-1","observed_at":"2026-09-21T14:59:59Z","temperature_c":1}`), ingMeta())
	if err != nil || r.StreamVersion != "1" {
		t.Fatalf("other device: %+v %v", r, err)
	}
}

func TestIngestRefusalsStoreNothing(t *testing.T) {
	f := ingSetup(t)
	stranger := Principal{Subject: randomUUID(), TenantID: f.tenant, Roles: []string{RoleDevice}}
	viewer := Principal{Subject: "u", TenantID: f.tenant, Roles: []string{"viewer"}}
	body := []byte(`{"source_message_id":"z","observed_at":"2026-09-21T14:59:59Z","temperature_c":1}`)
	ctx := context.Background()
	if _, err := f.ingestor.Ingest(ctx, stranger, f.device, body, ingMeta()); err == nil {
		t.Fatal("forged device accepted")
	} else {
		ingMustReject(t, err, ReasonDeviceForbidden, 403)
	}
	_, err := f.ingestor.Ingest(ctx, viewer, f.device, body, ingMeta())
	ingMustReject(t, err, ReasonDeviceForbidden, 403)
	_, err = f.ingestor.Ingest(ctx, f.principal(), "NOT-A-UUID", body, ingMeta())
	ingMustReject(t, err, ReasonInvalidField, 400)
	_, err = f.ingest("bad", `,"temperature_c":1e999`)
	ingMustReject(t, err, ReasonNonFiniteValue, 422)

	notReady := Principal{Subject: "op", TenantID: f.tenant, Roles: []string{"operator"}}
	_, err = f.ingestor.Ingest(ctx, notReady, randomUUID(), body, ingMeta())
	ingMustReject(t, err, ReasonDeviceNotReady, 409)

	if _, err := adminConn(t, ingTelemetryDB).Exec(ctx, "UPDATE device_bindings SET status = 'disabled' WHERE device_id = $1", f.device); err != nil {
		t.Fatal(err)
	}
	_, err = f.ingest("off", `,"temperature_c":1`)
	ingMustReject(t, err, ReasonDeviceDisabled, 403)
	if got := ingCounts(t, f); got != [5]int{0, 0, 0, 0, 0} {
		t.Fatalf("a refusal left rows behind: %v", got)
	}
}

func TestOperatorsAndAdminsMayPostForAnyDeviceOfTheirTenantOnly(t *testing.T) {
	f := ingSetup(t)
	body := []byte(`{"source_message_id":"op-1","observed_at":"2026-09-21T14:59:59Z","temperature_c":1}`)
	for i, role := range []string{RoleOperator, RoleAdmin} {
		p := Principal{Subject: "user-1", TenantID: f.tenant, Roles: []string{role}}
		body := bytes.Replace(body, []byte("op-1"), []byte(fmt.Sprintf("op-%d", i)), 1)
		r, err := f.ingestor.Ingest(context.Background(), p, f.device, body, ingMeta())
		if err != nil || r.StreamVersion != fmt.Sprint(i+1) {
			t.Fatalf("%s: %+v %v", role, r, err)
		}
	}
	if n := adminInt(t, "SELECT count(*) FROM audit_events WHERE tenant_id = $1 AND actor_type = 'user'", f.tenant); n != 2 {
		t.Fatalf("user audit rows %d", n)
	}
	other := Principal{Subject: "op", TenantID: randomUUID(), Roles: []string{RoleOperator, RoleAdmin}}
	_, err := f.ingestor.Ingest(context.Background(), other, f.device, body, ingMeta())
	ingMustReject(t, err, ReasonDeviceNotReady, 409)
	if got := ingCounts(t, f); got[0] != 2 {
		t.Fatalf(ingCountsFormat, got)
	}
}

func TestIngestRejectsAnInvalidTenantAndSurfacesInternalErrors(t *testing.T) {
	f := ingSetup(t)
	p := Principal{Subject: f.device, TenantID: "nope", Roles: []string{RoleDevice}}
	_, err := f.ingestor.Ingest(context.Background(), p, f.device,
		[]byte(`{"source_message_id":"a","observed_at":"2026-09-21T14:59:59Z","temperature_c":1}`), ingMeta())
	if !errors.Is(err, ErrInvalidTenant) {
		t.Fatalf("got %v", err)
	}
	// A malformed correlation id is a caller bug, reported as an internal error, not a refusal.
	_, err = f.ingestor.Ingest(context.Background(), f.principal(), f.device,
		[]byte(`{"source_message_id":"a","observed_at":"2026-09-21T14:59:59Z","temperature_c":1}`), RequestMeta{CorrelationID: "x", Traceparent: ingTraceparent})
	var rej *Rejection
	if err == nil || errors.As(err, &rej) {
		t.Fatalf("got %v", err)
	}
	if got := ingCounts(t, f); got != [5]int{0, 0, 0, 0, 0} {
		t.Fatalf(ingCountsFormat, got)
	}
}

func TestNewIngestorDefaultsTheClock(t *testing.T) {
	g := NewIngestor(nil, QualityPolicy{}, nil)
	if g.now == nil || time.Since(g.now()) > time.Minute || g.policy.MaxAge != defaultMaxAge || g.policy.MaxFutureSkew != defaultMaxFutureSkew {
		t.Fatalf("%+v", g)
	}
}

func TestTimestampBoundariesAgainstTheServerClock(t *testing.T) {
	f := ingSetup(t)
	at := func(id string, d time.Duration) error {
		body := fmt.Sprintf(`{"source_message_id":%q,"observed_at":%q,"temperature_c":1}`, id, ingNow.Add(d).Format(time.RFC3339Nano))
		_, err := f.ingestor.Ingest(context.Background(), f.principal(), f.device, []byte(body), ingMeta())
		return err
	}
	if err := at("skew-ok", 5*time.Minute); err != nil {
		t.Fatal(err)
	}
	ingMustReject(t, at("skew-bad", 5*time.Minute+time.Microsecond), ReasonTimestampInFuture, 422)
	if err := at("age-ok", -168*time.Hour); err != nil {
		t.Fatal(err)
	}
	ingMustReject(t, at("age-bad", -168*time.Hour-time.Microsecond), ReasonTimestampTooOld, 422)
}

// ingFaultDB wraps the real pool. It can fail before the nth write statement, or execute
// the commit on the server and then report a lost connection.
type ingFaultDB struct {
	TxStarter
	failWrite  int
	failCommit bool
	writes     int
}

type ingFaultTx struct {
	pgx.Tx
	db *ingFaultDB
}

var errIngFault = errors.New("injected fault")

func (d *ingFaultDB) BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error) {
	d.writes = 0
	tx, err := d.TxStarter.BeginTx(ctx, opts)
	return &ingFaultTx{Tx: tx, db: d}, err
}

func (x *ingFaultTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if strings.HasPrefix(sql, "INSERT") || strings.HasPrefix(sql, "UPDATE") {
		x.db.writes++
		if x.db.writes == x.db.failWrite {
			return pgconn.CommandTag{}, errIngFault
		}
	}
	return x.Tx.Exec(ctx, sql, args...)
}

func (x *ingFaultTx) Commit(ctx context.Context) error {
	if x.db.failCommit {
		_ = x.Tx.Commit(ctx)
		return errIngFault
	}
	return x.Tx.Commit(ctx)
}

func TestCrashBeforeAnyWriteRollsBackEverythingAndARetrySucceedsOnce(t *testing.T) {
	for write := 1; write <= 5; write++ {
		f := ingSetup(t)
		faulty := &ingFaultDB{TxStarter: f.db, failWrite: write}
		f.ingestor = ingNewIngestor(faulty)
		if _, err := f.ingest("crash", `,"temperature_c":4`); !errors.Is(err, errIngFault) {
			t.Fatalf("write %d: %v", write, err)
		}
		if got := ingCounts(t, f); got != [5]int{0, 0, 0, 0, 0} {
			t.Fatalf("write %d left a partial result: %v", write, got)
		}
		f.ingestor = ingNewIngestor(f.db)
		if _, err := f.ingest("crash", `,"temperature_c":4`); err != nil {
			t.Fatalf("write %d retry: %v", write, err)
		}
		if got := ingCounts(t, f); got != [5]int{1, 1, 1, 1, 1} {
			t.Fatalf("write %d after retry: %v", write, got)
		}
	}
}

func TestAmbiguousCommitIsResolvedByTheReceiptOnRetry(t *testing.T) {
	f := ingSetup(t)
	f.ingestor = ingNewIngestor(&ingFaultDB{TxStarter: f.db, failCommit: true})
	if _, err := f.ingest("ambiguous", `,"temperature_c":4`); !errors.Is(err, errIngFault) {
		t.Fatalf("got %v", err)
	}
	if got := ingCounts(t, f); got != [5]int{1, 1, 1, 1, 1} {
		t.Fatalf("the server committed, counts %v", got)
	}
	stored := adminInt(t, "SELECT count(*) FROM ingest_receipts WHERE tenant_id = $1 AND source_message_id = 'ambiguous'", f.tenant)
	f.ingestor = ingNewIngestor(f.db)
	result, err := f.ingest("ambiguous", `,"temperature_c":4`)
	if err != nil || stored != 1 {
		t.Fatalf("%+v %v", result, err)
	}
	if n := adminInt(t, "SELECT count(*) FROM ingest_receipts WHERE reading_id = $1 AND event_id = $2", result.ReadingID, result.EventID); n != 1 {
		t.Fatal("the retry must return the IDs of the committed reading")
	}
	if got := ingCounts(t, f); got != [5]int{1, 1, 1, 1, 1} {
		t.Fatalf(ingCountsFormat, got)
	}
}

// Scripted statements in the order storeReading issues them.
func ingHappySteps(status string) []step {
	binding := func(d []any) {
		*(d[0].(*string)) = randomUUID()
		*(d[1].(**string)) = nil
		*(d[2].(*int64)) = 1
		*(d[3].(*string)) = status
	}
	return []step{
		{rows: 1}, {scan: setInt64(0)}, {err: pgx.ErrNoRows}, {scan: binding},
		{rows: 1}, {rows: 1}, {rows: 1}, {rows: 1}, {rows: 1},
	}
}

func ingScripted(steps []step) *Ingestor { return ingNewIngestor(scriptDB{steps}) }

func ingScriptedIngest(g *Ingestor) (IngestResult, error) {
	tenant, device := randomUUID(), randomUUID()
	p := Principal{Subject: device, TenantID: tenant, Roles: []string{RoleDevice}}
	return g.Ingest(context.Background(), p, device,
		[]byte(`{"source_message_id":"s","observed_at":"2026-09-21T14:59:59Z","temperature_c":1}`), ingMeta())
}

func TestEveryStatementFailureInIngestIsReportedAsAnInternalError(t *testing.T) {
	steps := ingHappySteps(bindingActive)
	if r, err := ingScriptedIngest(ingScripted(steps)); err != nil || r.StreamVersion != "1" {
		t.Fatalf("scripted happy path: %+v %v", r, err)
	}
	for i := range steps {
		failing := append([]step(nil), steps...)
		failing[i] = step{err: errBoom}
		_, err := ingScriptedIngest(ingScripted(failing))
		var rej *Rejection
		if !errors.Is(err, errBoom) || errors.As(err, &rej) {
			t.Errorf("statement %d failing: %v", i+1, err)
		}
	}
}

func TestScriptedRefusalsAndCorruptReceipts(t *testing.T) {
	steps := ingHappySteps("disabled")
	_, err := ingScriptedIngest(ingScripted(steps))
	ingMustReject(t, err, ReasonDeviceDisabled, 403)

	steps = ingHappySteps(bindingActive)
	steps[1] = step{err: pgx.ErrNoRows}
	_, err = ingScriptedIngest(ingScripted(steps))
	ingMustReject(t, err, ReasonDeviceNotReady, 409)

	receipt := func(body string, same bool) step {
		return step{scan: func(d []any) { *(d[0].(*[]byte)) = []byte(body); *(d[1].(*bool)) = same }}
	}
	steps = ingHappySteps(bindingActive)
	steps[2] = receipt(`{"status":"stored","reading_id":"r","event_id":"e","stream_version":"9","projection_status":"pending"}`, true)
	if r, err := ingScriptedIngest(ingScripted(steps)); err != nil || r.StreamVersion != "9" {
		t.Fatalf("%+v %v", r, err)
	}
	steps[2] = receipt(`{}`, false)
	_, err = ingScriptedIngest(ingScripted(steps))
	ingMustReject(t, err, ReasonIdempotencyConflict, 409)
	steps[2] = receipt(`not json`, true)
	if _, err = ingScriptedIngest(ingScripted(steps)); err == nil || !strings.Contains(err.Error(), "decode stored receipt") {
		t.Fatalf("got %v", err)
	}
}

func TestIngestRefusesMalformedRequestMetaBeforeTouchingTheDatabase(t *testing.T) {
	tenant, device := randomUUID(), randomUUID()
	principal := Principal{Subject: "op-1", TenantID: tenant, Roles: []string{RoleOperator}}
	good := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	body := []byte(`{"source_message_id":"m-1","observed_at":"2026-09-21T15:00:00Z","temperature_c":20}`)
	for name, meta := range map[string]RequestMeta{
		"bad correlation": {CorrelationID: "not-a-uuid", Traceparent: good},
		"empty":           {},
		"flags 03":        {CorrelationID: randomUUID(), Traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03"},
		"zero trace id":   {CorrelationID: randomUUID(), Traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01"},
		"zero span id":    {CorrelationID: randomUUID(), Traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"},
		"uppercase trace": {CorrelationID: randomUUID(), Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01"},
	} {
		_, err := NewIngestor(failingDB{}, QualityPolicy{}, nil).Ingest(context.Background(), principal, device, body, meta)
		if !errors.Is(err, errInvalidRequestMeta) {
			t.Errorf("%s: got %v", name, err)
		}
	}
	if err := checkRequestMeta(RequestMeta{CorrelationID: randomUUID(), Traceparent: good}); err != nil {
		t.Fatalf("valid meta refused: %v", err)
	}
}
