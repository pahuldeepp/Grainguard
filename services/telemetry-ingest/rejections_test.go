package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type ingCounter struct {
	mu      sync.Mutex
	reasons []string
}

func (c *ingCounter) IncRejection(reason string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reasons = append(c.reasons, reason)
}

// ingClock advances by step on every reading.
type ingClock struct {
	t    time.Time
	step time.Duration
}

func (c *ingClock) now() time.Time {
	c.t = c.t.Add(c.step)
	return c.t
}

var ingRejection = &Rejection{Reason: ReasonValueOutOfRange, Status: 422, Detail: "x"}

func ingSamples(t *testing.T, tenant, device string) int {
	t.Helper()
	return adminInt(t, "SELECT count(*) FROM ingest_rejection_samples WHERE tenant_id = $1 AND device_id = $2", tenant, device)
}

func TestHundredRejectionsLeaveAtMostTwentySamplesAndNeverStoreTheBody(t *testing.T) {
	db := pooled(t, 4)
	tenant := randomUUID()
	device, _, _ := ingBinding(t, db, tenant)
	counter := &ingCounter{}
	clock := &ingClock{t: ingNow, step: 11 * time.Second}
	rec := NewRejectionRecorder(db, counter, clock.now)
	body := []byte(`{"secret":"payload"}`)
	for i := 0; i < 100; i++ {
		rec.Record(context.Background(), tenant, device, ingRejection, body)
	}
	if len(counter.reasons) != 100 {
		t.Fatalf("counted %d", len(counter.reasons))
	}
	if n := ingSamples(t, tenant, device); n < 1 || n > rejectionSlots {
		t.Fatalf("samples %d", n)
	}
	digest := sha256.Sum256(body)
	if n := adminInt(t, "SELECT count(*) FROM ingest_rejection_samples WHERE tenant_id = $1 AND payload_sha256 = $2 AND reason = $3",
		tenant, hex.EncodeToString(digest[:]), ReasonValueOutOfRange); n != ingSamples(t, tenant, device) {
		t.Fatal("every sample must hold only the digest and the reason")
	}
}

func TestRejectionSamplesAreThrottledPerDevice(t *testing.T) {
	db := pooled(t, 2)
	tenant := randomUUID()
	device, _, _ := ingBinding(t, db, tenant)
	other, _, _ := ingBinding(t, db, tenant)
	counter := &ingCounter{}
	clock := &ingClock{t: ingNow}
	rec := NewRejectionRecorder(db, counter, clock.now)
	for i := 0; i < 30; i++ {
		rec.Record(context.Background(), tenant, device, ingRejection, nil)
	}
	if n := ingSamples(t, tenant, device); n != 1 {
		t.Fatalf("a burst within the throttle window wrote %d samples", n)
	}
	rec.Record(context.Background(), tenant, other, ingRejection, nil)
	if n := ingSamples(t, tenant, other); n != 1 {
		t.Fatalf("another device is not throttled by the first: %d", n)
	}
	if len(counter.reasons) != 31 {
		t.Fatalf("counted %d", len(counter.reasons))
	}
}

func TestRejectionsWithoutValidIdentityAreOnlyCounted(t *testing.T) {
	counter := &ingCounter{}
	rec := NewRejectionRecorder(scriptDB{}, counter, nil)
	rec.Record(context.Background(), "bad", randomUUID(), ingRejection, nil)
	rec.Record(context.Background(), randomUUID(), "bad", ingRejection, nil)
	if len(counter.reasons) != 2 || len(rec.last) != 0 {
		t.Fatalf("counted %d, throttle entries %d", len(counter.reasons), len(rec.last))
	}
}

func TestThrottleMapIsBoundedAndResetsWhenFull(t *testing.T) {
	rec := NewRejectionRecorder(scriptDB{steps: []step{{rows: 1}, {rows: 1}}}, &ingCounter{}, nil)
	rec.capacity = 3
	tenant := randomUUID()
	for i := 0; i < 10; i++ {
		rec.Record(context.Background(), tenant, randomUUID(), ingRejection, nil)
		if len(rec.last) > 3 {
			t.Fatalf("throttle map grew to %d", len(rec.last))
		}
	}
}

func TestRecordNeverFailsTheCallerWhenTheDatabaseDoes(t *testing.T) {
	for i := 0; i < 2; i++ {
		steps := []step{{rows: 1}, {rows: 1}}
		steps[i] = step{err: errBoom}
		counter := &ingCounter{}
		NewRejectionRecorder(scriptDB{steps}, counter, nil).Record(context.Background(), randomUUID(), randomUUID(), ingRejection, nil)
		if len(counter.reasons) != 1 {
			t.Fatalf("counted %d", len(counter.reasons))
		}
	}
}

func ingExec(db TxStarter, tenant, sql string, args ...any) error {
	return WithTenant(context.Background(), db, tenant, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, sql, args...)
		return err
	})
}

func TestRejectionSamplesAreTenantIsolatedAndOverwriteOnly(t *testing.T) {
	db := pooled(t, 4)
	a, b := randomUUID(), randomUUID()
	deviceA, _, _ := ingBinding(t, db, a)
	NewRejectionRecorder(db, &ingCounter{}, nil).Record(context.Background(), a, deviceA, ingRejection, []byte("x"))
	if ingSamples(t, a, deviceA) != 1 {
		t.Fatal("sample missing")
	}
	err := WithTenant(context.Background(), db, b, func(ctx context.Context, tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM ingest_rejection_samples").Scan(&n); err != nil || n != 0 {
			t.Errorf("tenant B sees %d samples: %v", n, err)
		}
		tag, err := tx.Exec(ctx, "UPDATE ingest_rejection_samples SET reason = 'x'")
		if err != nil || tag.RowsAffected() != 0 {
			t.Errorf("tenant B updated tenant A's sample: %v %v", tag, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = ingExec(db, b, "INSERT INTO ingest_rejection_samples VALUES ($1, $2, 0, 'r', 'h', now())", a, deviceA)
	if sqlState(unwrapAll(err)) != "42501" {
		t.Errorf("forged tenant insert must fail with 42501: %v", err)
	}
	for name, sql := range map[string]string{
		"delete":        "DELETE FROM ingest_rejection_samples",
		"rewrite slot":  "UPDATE ingest_rejection_samples SET slot = 1",
		"rewrite owner": "UPDATE ingest_rejection_samples SET device_id = gen_random_uuid()",
	} {
		if err := ingExec(db, a, sql); sqlState(unwrapAll(err)) != "42501" {
			t.Errorf("%s: want 42501, got %v", name, err)
		}
	}
	err = ingExec(db, a, "INSERT INTO ingest_rejection_samples VALUES ($1, $2, 20, 'r', 'h', now())", a, deviceA)
	if sqlState(unwrapAll(err)) != "23514" {
		t.Fatalf("slot 20 must violate the check constraint: %v", err)
	}
}

func TestOnlyDevicesWithABindingGetRejectionSamples(t *testing.T) {
	db := pooled(t, 4)
	tenant := randomUUID()
	bound, _, _ := ingBinding(t, db, tenant)
	rec := NewRejectionRecorder(db, &ingCounter{}, (&ingClock{t: ingNow, step: 11 * time.Second}).now)
	for i := 0; i < 5; i++ {
		rec.Record(context.Background(), tenant, randomUUID(), ingRejection, []byte("x"))
	}
	if n := adminInt(t, "SELECT count(*) FROM ingest_rejection_samples WHERE tenant_id = $1", tenant); n != 0 {
		t.Fatalf("unbound, caller-chosen device ids must never create sample rows, found %d", n)
	}
	rec.Record(context.Background(), tenant, bound, ingRejection, []byte("x"))
	if ingSamples(t, tenant, bound) != 1 {
		t.Fatal("a bound device still gets a sample")
	}
}

func TestNotReadyRejectionsAreCountedButNeverSampled(t *testing.T) {
	db := pooled(t, 4)
	tenant := randomUUID()
	device, _, _ := ingBinding(t, db, tenant)
	counter := &ingCounter{}
	rec := NewRejectionRecorder(db, counter, (&ingClock{t: ingNow, step: 11 * time.Second}).now)
	rec.Record(context.Background(), tenant, device, &Rejection{Reason: ReasonDeviceNotReady, Status: 409}, []byte("x"))
	if len(counter.reasons) != 1 || counter.reasons[0] != ReasonDeviceNotReady {
		t.Fatalf("counted %v", counter.reasons)
	}
	if ingSamples(t, tenant, device) != 0 {
		t.Fatal("a not-ready rejection must not be sampled")
	}
}
