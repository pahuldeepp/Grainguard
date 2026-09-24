package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

const fixtures = "../../tests/fixtures/events"

func TestParseInventoryEventAcceptsSharedFixtures(t *testing.T) {
	want := map[string]struct {
		kind, status string
		version      int64
	}{
		"device-registered.v1.valid.json":      {"device.registered", "active", 7},
		"device-binding-changed.v1.valid.json": {"device.binding_changed", "", 7},
		"device-status-changed.v1.valid.json":  {"device.status_changed", "disabled", 7},
	}
	for name, exp := range want {
		data, err := os.ReadFile(filepath.Join(fixtures, name))
		if err != nil {
			t.Fatal(err)
		}
		event, err := ParseInventoryEvent(data)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if event.EventType != exp.kind || event.Status != exp.status || event.Version != exp.version {
			t.Fatalf("%s: got %+v", name, event)
		}
	}
}

func TestParseInventoryEventRejectsUnsafeFixtures(t *testing.T) {
	for _, name := range []string{
		"aggregate-version-exceeds-int64", "aggregate-version-is-number", "aggregate-version-leading-zero",
		"aggregate-version-negative", "aggregate-version-zero", "binding-version-differs-from-aggregate-version",
		"binding-version-exceeds-int64", "device-id-differs-from-aggregate-id", "missing-payload-site-id",
		"missing-tenant-id", "nil-event-id", "nil-tenant-id", "status-not-in-enum", "unknown-event-type",
		"unknown-schema-version", "uppercase-tenant-id",
	} {
		data, err := os.ReadFile(filepath.Join(fixtures, "invalid", name+".json"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ParseInventoryEvent(data); !errors.Is(err, ErrInvalidEvent) {
			t.Errorf("%s: got %v, want ErrInvalidEvent", name, err)
		}
	}
}

func TestParseInventoryEventEdgeCases(t *testing.T) {
	tenant, device := randomUUID(), randomUUID()
	cases := map[string][]byte{
		"not json":          []byte("{"),
		"bad bin":           eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1, bin: "nope"}.json(),
		"registered status": eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1, status: "gone"}.json(),
		"status_changed":    eventSpec{kind: "device.status_changed", tenant: tenant, device: device, version: 2, status: "gone"}.json(),
		"wrong aggregate":   []byte(`{"event_id":"` + randomUUID() + `","event_type":"device.registered","schema_version":1,"tenant_id":"` + tenant + `","aggregate_type":"reading","aggregate_id":"` + device + `","aggregate_version":"1","payload":{"device_id":"` + device + `","binding_version":"1"}}`),
	}
	for name, data := range cases {
		if _, err := ParseInventoryEvent(data); !errors.Is(err, ErrInvalidEvent) {
			t.Errorf("%s: got %v", name, err)
		}
	}
	ok := eventSpec{kind: "device.binding_changed", tenant: tenant, device: device, version: 2, bin: nil}.json()
	event, err := ParseInventoryEvent(ok)
	if err != nil || event.BinID != nil {
		t.Fatalf("null bin must parse as absent: %+v %v", event, err)
	}
	if _, err := ApplyInventoryEvent(context.Background(), nil, []byte("{")); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("apply must reject invalid events before touching the database: %v", err)
	}
}

func apply(t *testing.T, db TxStarter, spec eventSpec) (BindingOutcome, error) {
	t.Helper()
	return ApplyInventoryEvent(context.Background(), db, spec.json())
}

func mustApply(t *testing.T, db TxStarter, spec eventSpec, want BindingOutcome) {
	t.Helper()
	got, err := apply(t, db, spec)
	if err != nil || got != want {
		t.Fatalf("%s v%d: got %q, %v; want %q", spec.kind, spec.version, got, err, want)
	}
}

func TestRegisteredEventCreatesBindingAndStream(t *testing.T) {
	db := pooled(t, 4)
	tenant, device, site, bin := randomUUID(), randomUUID(), randomUUID(), randomUUID()
	reg := eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1, site: site, bin: bin}
	mustApply(t, db, reg, BindingApplied)
	var status string
	var version, last int64
	err := adminConn(t, "greenguard_telemetry").QueryRow(context.Background(),
		`SELECT b.status, b.inventory_version, s.last_version FROM device_bindings b
		 JOIN device_streams s USING (tenant_id, device_id) WHERE b.tenant_id = $1 AND b.device_id = $2`,
		tenant, device).Scan(&status, &version, &last)
	if err != nil || status != "active" || version != 1 || last != 0 {
		t.Fatalf("got %q %d %d %v", status, version, last, err)
	}
	mustApply(t, db, eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1}, BindingStale)
	if n := adminInt(t, "SELECT count(*) FROM device_streams WHERE device_id = $1", device); n != 1 {
		t.Fatalf("stream rows: %d", n)
	}
}

func TestDuplicateDeliveryHasOneEffectAndReusedIDsConflict(t *testing.T) {
	db := pooled(t, 4)
	tenant, device := randomUUID(), randomUUID()
	reg := eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1}.withIDs()
	mustApply(t, db, reg, BindingApplied)
	mustApply(t, db, reg, BindingDuplicate)
	changed := reg
	changed.site = randomUUID()
	if _, err := apply(t, db, changed); !errors.Is(err, ErrEventConflict) {
		t.Fatalf("same event ID with other content: %v", err)
	}
	if n := adminInt(t, "SELECT count(*) FROM consumer_inbox WHERE tenant_id = $1", tenant); n != 1 {
		t.Fatalf("inbox rows: %d", n)
	}
}

func TestChangesMustFollowTheDeviceSequence(t *testing.T) {
	db := pooled(t, 4)
	tenant, device, site2 := randomUUID(), randomUUID(), randomUUID()
	mustApply(t, db, eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1}, BindingApplied)
	if _, err := apply(t, db, eventSpec{kind: "device.status_changed", tenant: tenant, device: device, version: 3, status: "disabled"}); !errors.Is(err, ErrVersionGap) {
		t.Fatalf("v3 before v2: %v", err)
	}
	if n := adminInt(t, "SELECT count(*) FROM consumer_inbox WHERE tenant_id = $1", tenant); n != 1 {
		t.Fatalf("a rejected event must not leave a receipt, got %d", n)
	}
	mustApply(t, db, eventSpec{kind: "device.binding_changed", tenant: tenant, device: device, version: 2, site: site2}, BindingApplied)
	mustApply(t, db, eventSpec{kind: "device.status_changed", tenant: tenant, device: device, version: 3, status: "disabled"}, BindingApplied)
	mustApply(t, db, eventSpec{kind: "device.status_changed", tenant: tenant, device: device, version: 3, status: "active"}, BindingStale)
	var status string
	var site string
	var version int64
	err := adminConn(t, "greenguard_telemetry").QueryRow(context.Background(),
		"SELECT status, site_id::text, inventory_version FROM device_bindings WHERE device_id = $1", device).Scan(&status, &site, &version)
	if err != nil || status != "disabled" || site != site2 || version != 3 {
		t.Fatalf("got %q %q %d %v", status, site, version, err)
	}
}

func TestChangeForAnUnknownDeviceWaitsForRegistration(t *testing.T) {
	db := pooled(t, 4)
	tenant, device := randomUUID(), randomUUID()
	change := eventSpec{kind: "device.binding_changed", tenant: tenant, device: device, version: 2}
	if _, err := apply(t, db, change); !errors.Is(err, ErrBindingMissing) {
		t.Fatalf("got %v", err)
	}
	mustApply(t, db, eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1}, BindingApplied)
	mustApply(t, db, change, BindingApplied)
}

func TestConcurrentDuplicateDeliveriesConvergeOnOneEffect(t *testing.T) {
	db := pooled(t, 8)
	tenant, device := randomUUID(), randomUUID()
	reg := eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1}.withIDs()
	var wg sync.WaitGroup
	results := make(chan BindingOutcome, 10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			outcome, err := apply(t, db, reg)
			if err != nil {
				t.Error(err)
			}
			results <- outcome
		}()
	}
	wg.Wait()
	close(results)
	counts := map[BindingOutcome]int{}
	for outcome := range results {
		counts[outcome]++
	}
	if counts[BindingApplied] != 1 || counts[BindingDuplicate] != 9 {
		t.Fatalf("outcomes: %v", counts)
	}
	if n := adminInt(t, "SELECT count(*) FROM device_bindings WHERE device_id = $1", device); n != 1 {
		t.Fatalf("bindings: %d", n)
	}
}

func TestConcurrentCompetingChangesApplyOnce(t *testing.T) {
	db := pooled(t, 8)
	tenant, device := randomUUID(), randomUUID()
	mustApply(t, db, eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1}, BindingApplied)
	var wg sync.WaitGroup
	results := make(chan BindingOutcome, 2)
	for _, status := range []string{"disabled", "deleted"} {
		wg.Add(1)
		go func(status string) {
			defer wg.Done()
			outcome, err := apply(t, db, eventSpec{kind: "device.status_changed", tenant: tenant, device: device, version: 2, status: status})
			if err != nil {
				t.Error(err)
			}
			results <- outcome
		}(status)
	}
	wg.Wait()
	close(results)
	counts := map[BindingOutcome]int{}
	for outcome := range results {
		counts[outcome]++
	}
	if counts[BindingApplied] != 1 || counts[BindingStale] != 1 {
		t.Fatalf("outcomes: %v", counts)
	}
}

func TestApplyReportsDatabaseFailures(t *testing.T) {
	tenant, device := randomUUID(), randomUUID()
	if _, err := ApplyInventoryEvent(context.Background(), failingDB{}, eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1}.json()); err == nil {
		t.Fatal("expected a begin failure")
	}
}
