package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"greenguard.local/saga-orchestrator/saga"
)

func liveUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func TestLiveLeasedWorkerPublishesOnlyHeldShards(t *testing.T) {
	url := os.Getenv("SAGA_DIRECT_URL")
	if url == "" {
		t.Skip("SAGA_DIRECT_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	configureFixturePlacement(t, cfg)
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext('saga-lease-live-tests'))`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = conn.Exec(context.Background(), `SELECT pg_advisory_unlock(hashtext('saga-lease-live-tests'))`)
	}()
	leases := &saga.Leases{DB: pool, Holder: "loop-" + liveUUID(t), TTL: 2 * time.Second, MaxShards: saga.ShardCount}
	defer func() { _ = leases.Release(context.Background()) }()
	published := 0
	w := worker{db: pool, store: saga.Store{DB: pool, Fence: leases}, leases: leases, metrics: &saga.Metrics{},
		publish: func(context.Context, []byte, []byte) error { published++; return nil }}
	for end := time.Now().Add(8 * time.Second); len(leases.Held()) == 0 && time.Now().Before(end); time.Sleep(200 * time.Millisecond) {
		if err := w.renew(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if len(leases.Held()) == 0 {
		t.Fatal("no free shard for the worker loop test")
	}
	tenant := ""
	for tenant == "" {
		id := liveUUID(t)
		if _, ok := leases.Held()[saga.ShardFor(id)]; ok {
			tenant = id
		}
	}
	if _, err := (saga.Store{DB: pool}).Start(ctx, saga.StartRequest{TenantID: tenant,
		IdempotencyKey: liveUUID(t), DeviceID: liveUUID(t), AssetID: liveUUID(t)}); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 1)
	loopCtx, stop := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer stop()
	if err := w.loop(loopCtx, 2*time.Second, results); err != nil {
		t.Fatalf("loop: %v", err)
	}
	if published == 0 {
		t.Fatal("leased worker did not publish the pending command")
	}
	boom := errors.New("result consumer failed")
	results <- boom
	if err := w.loop(ctx, 2*time.Second, results); !errors.Is(err, boom) {
		t.Fatalf("consumer failure must stop the loop: %v", err)
	}
	if err := w.eachTenant(ctx, func(string) error { return saga.ErrLeaseLost }); err != nil {
		t.Fatalf("lost lease must skip, not fail: %v", err)
	}
}
