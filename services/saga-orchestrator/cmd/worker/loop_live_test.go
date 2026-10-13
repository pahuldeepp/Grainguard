package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
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
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := loopTestPool(t, ctx)
	defer pool.Close()
	w, published := loopTestWorker(t, pool)
	defer func() { _ = w.leases.Release(context.Background()) }()
	tenant := acquireLoopTenant(t, ctx, w)
	unheldTenant := liveUUID(t)
	for saga.ShardFor(unheldTenant) == saga.ShardFor(tenant) {
		unheldTenant = liveUUID(t)
	}
	started := startLoopSaga(t, ctx, pool, tenant)
	startLoopSaga(t, ctx, pool, unheldTenant)
	results := make(chan error, 1)
	loopCtx, stop := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer stop()
	if err := w.loop(loopCtx, 2*time.Second, results); err != nil {
		t.Fatalf("loop: %v", err)
	}
	assertLoopPublication(t, ctx, w, published, tenant, unheldTenant, started.SagaID)
	assertLoopErrors(t, ctx, w, results)
}

func loopTestPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("SAGA_DIRECT_URL")
	if url == "" {
		t.Skip("SAGA_DIRECT_URL is required")
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	isolateLoopDatabase(t, cfg)
	configureFixturePlacement(t, cfg)
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	return pool
}

func loopTestWorker(t *testing.T, pool *pgxpool.Pool) (worker, *[]saga.Command) {
	t.Helper()
	leases := &saga.Leases{DB: pool, Holder: "loop-" + liveUUID(t), TTL: 2 * time.Second, MaxShards: 1}
	var published []saga.Command
	w := worker{db: pool, store: saga.Store{DB: pool, Fence: leases}, leases: leases, metrics: &saga.Metrics{},
		publish: func(_ context.Context, _ []byte, value []byte) error {
			var command saga.Command
			if err := json.Unmarshal(value, &command); err != nil {
				return err
			}
			if _, held := leases.Held()[saga.ShardFor(command.TenantID)]; !held {
				t.Errorf("published a command for an unheld shard")
			}
			published = append(published, command)
			return nil
		}}
	return w, &published
}

func acquireLoopTenant(t *testing.T, ctx context.Context, w worker) string {
	t.Helper()
	for end := time.Now().Add(8 * time.Second); len(w.leases.Held()) == 0 && time.Now().Before(end); time.Sleep(200 * time.Millisecond) {
		if err := w.renew(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if len(w.leases.Held()) == 0 {
		t.Fatal("no free shard for the worker loop test")
	}
	for {
		id := liveUUID(t)
		if _, ok := w.leases.Held()[saga.ShardFor(id)]; ok {
			return id
		}
	}
}

func startLoopSaga(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenant string) saga.Snapshot {
	t.Helper()
	started, err := (saga.Store{DB: pool}).Start(ctx, saga.StartRequest{TenantID: tenant,
		IdempotencyKey: liveUUID(t), DeviceID: liveUUID(t), AssetID: liveUUID(t)})
	if err != nil {
		t.Fatal(err)
	}
	return started
}

func assertLoopPublication(t *testing.T, ctx context.Context, w worker, published *[]saga.Command, tenant, unheldTenant, sagaID string) {
	t.Helper()
	commands := *published
	if len(commands) != 1 || commands[0].TenantID != tenant || commands[0].SagaID != sagaID {
		t.Fatalf("worker must publish exactly its fixture command: got %+v", commands)
	}
	assertLoopPending(t, ctx, w.db, tenant, 0)
	assertLoopPending(t, ctx, w.db, unheldTenant, 1)
	if sent, err := w.store.PublishNextCommand(ctx, unheldTenant, w.publish); sent || !errors.Is(err, saga.ErrLeaseLost) {
		t.Fatalf("unheld shard must refuse publication: sent=%v err=%v", sent, err)
	}
	if len(*published) != 1 {
		t.Fatal("unheld shard reached publisher")
	}
}

func assertLoopPending(t *testing.T, ctx context.Context, db common.TxStarter, tenant string, want int) {
	t.Helper()
	if err := common.WithTenantSchema(ctx, db, tenant, "", func(ctx context.Context, tx pgx.Tx) error {
		var pending int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM saga_command_outbox WHERE tenant_id=$1 AND published_at IS NULL", tenant).Scan(&pending); err != nil {
			return err
		}
		if pending != want {
			t.Errorf("pending fixture commands: got %d want %d", pending, want)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func assertLoopErrors(t *testing.T, ctx context.Context, w worker, results chan error) {
	t.Helper()
	boom := errors.New("result consumer failed")
	results <- boom
	if err := w.loop(ctx, 2*time.Second, results); !errors.Is(err, boom) {
		t.Fatalf("consumer failure must stop the loop: %v", err)
	}
	visits := 0
	if err := w.eachTenant(ctx, func(string) error { visits++; return saga.ErrLeaseLost }); err != nil {
		t.Fatalf("lost lease must skip, not fail: %v", err)
	}
	if visits != 1 {
		t.Fatalf("lost-lease branch visits: got %d want 1", visits)
	}
}
