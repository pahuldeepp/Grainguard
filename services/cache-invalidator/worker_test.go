package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeSource struct {
	mu      sync.Mutex
	commits int
	records []Record
}

func (f *fakeSource) Poll(context.Context, int) ([]Record, error) { return nil, nil }
func (f *fakeSource) Commit(_ context.Context, records []Record) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commits++
	f.records = append(f.records, records...)
	return nil
}
func (f *fakeSource) AllowRebalance() {}

type fakeBumper struct {
	mu   sync.Mutex
	fail bool
	keys []string
}

func (f *fakeBumper) Bump(_ context.Context, key string, _ int64, _ time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return errors.New("redis unavailable")
	}
	f.keys = append(f.keys, key)
	return nil
}

func notificationRecord(t *testing.T, tenant, scope, device string) Record {
	t.Helper()
	data, err := json.Marshal(map[string]any{"event_type": notificationType, "tenant_id": tenant,
		"occurred_at": time.Now().UTC().Format(time.RFC3339Nano), "payload": map[string]string{"scope": scope, "resource_id": device}})
	if err != nil {
		t.Fatal(err)
	}
	return Record{Topic: notificationTopic, Partition: 0, Offset: 1, Value: data}
}

func testWorker(src *fakeSource, bump *fakeBumper) *Worker {
	return &Worker{Source: src, Bumper: bump, Metrics: newMetrics(), Now: time.Now,
		Settings: Settings{Attempts: 1, OpTimeout: 10 * time.Millisecond, Backoff: time.Millisecond,
			VersionTTL: time.Hour, Concurrency: 1, CommitTimeout: time.Second}}
}

func TestCommittedEffectBeforeOffsetCommit(t *testing.T) {
	src, bump := &fakeSource{}, &fakeBumper{}
	w := testWorker(src, bump)
	b := newBatch()
	b.add(notificationRecord(t, "tenant-A", scopeDevice, "sensor-A"))
	if err := w.flush(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if src.commits != 1 || len(bump.keys) != 1 || bump.keys[0] != deviceVersionKey("tenant-A", "sensor-A") {
		t.Fatalf("commit=%d keys=%v", src.commits, bump.keys)
	}
}

func TestRedisFailureLeavesOffsetUncommittedForCrashReplay(t *testing.T) {
	src, bump := &fakeSource{}, &fakeBumper{fail: true}
	w := testWorker(src, bump)
	b := newBatch()
	b.add(notificationRecord(t, "tenant-A", scopeDevice, "sensor-A"))
	if err := w.flush(context.Background(), b); !errors.Is(err, errInvalidationUnconfirmed) {
		t.Fatalf("flush err=%v", err)
	}
	if src.commits != 0 {
		t.Fatalf("unconfirmed invalidation committed %d offsets", src.commits)
	}
	// A new worker represents process restart. Kafka redelivers the same record.
	bump.fail = false
	restarted := testWorker(src, bump)
	if err := restarted.flush(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if src.commits != 1 || len(bump.keys) != 1 {
		t.Fatalf("replay: commits=%d keys=%v", src.commits, bump.keys)
	}
}

func TestRedisRecoveryConfirmsEpochBeforeCommit(t *testing.T) {
	src, bump := &fakeSource{}, &fakeBumper{fail: true}
	w := testWorker(src, bump)
	b := newBatch()
	b.add(notificationRecord(t, "tenant-A", scopeDevice, "sensor-A"))
	if err := w.flush(context.Background(), b); !errors.Is(err, errInvalidationUnconfirmed) {
		t.Fatalf("initial outage: %v", err)
	}
	bump.fail = false
	if err := w.flush(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if src.commits != 1 || len(bump.keys) != 2 || bump.keys[0] != epochKey || bump.keys[1] != deviceVersionKey("tenant-A", "sensor-A") {
		t.Fatalf("recovery committed before epoch/device bump: commits=%d keys=%v", src.commits, bump.keys)
	}
}

func TestTenantAndDeviceBumpsStayScoped(t *testing.T) {
	src, bump := &fakeSource{}, &fakeBumper{}
	w := testWorker(src, bump)
	b := newBatch()
	b.add(notificationRecord(t, "tenant-A", scopeDevice, "sensor-A"))
	b.add(notificationRecord(t, "tenant-A", scopeTenant, ""))
	b.add(notificationRecord(t, "tenant-B", scopeDevice, "sensor-B"))
	if err := w.flush(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, key := range bump.keys {
		seen[key] = true
	}
	if len(seen) != 2 || !seen[generationKey("tenant-A")] || !seen[deviceVersionKey("tenant-B", "sensor-B")] || seen[deviceVersionKey("tenant-A", "sensor-A")] {
		t.Fatalf("scoped coalescing: %v", seen)
	}
}

func TestPromotionEpochSupersedesPerTenantBumps(t *testing.T) {
	src, bump := &fakeSource{}, &fakeBumper{}
	w := testWorker(src, bump)
	b := newBatch()
	b.add(notificationRecord(t, "tenant-A", scopeDevice, "sensor-A"))
	b.add(notificationRecord(t, "tenant-B", scopeTenant, ""))
	data, err := json.Marshal(map[string]any{"event_type": notificationType, "tenant_id": infrastructureTenant,
		"occurred_at": time.Now().UTC().Format(time.RFC3339Nano), "payload": map[string]string{
			"scope": scopeEpoch, "purpose": "promotion_changed", "source_event_type": "projection.promoted"}})
	if err != nil {
		t.Fatal(err)
	}
	b.add(Record{Topic: notificationTopic, Partition: 0, Offset: 3, Value: data})
	if err := w.flush(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if src.commits != 1 || len(bump.keys) != 1 || bump.keys[0] != epochKey {
		t.Fatalf("epoch not coalesced: commits=%d keys=%v", src.commits, bump.keys)
	}
	data[0] = 'x'
	if _, err := parseTarget(data); !errors.Is(err, errInvalidNotification) {
		t.Fatalf("malformed epoch accepted: %v", err)
	}
}
