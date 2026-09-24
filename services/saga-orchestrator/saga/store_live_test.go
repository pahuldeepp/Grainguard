package saga

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
)

func testUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("SAGA_DIRECT_URL")
	if url == "" {
		t.Skip("SAGA_DIRECT_URL is required for the live saga database test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	return pool
}

func TestLiveStartIsAtomicIdempotentAndTenantIsolated(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s := Store{DB: pool}
	a, b := testUUID(t), testUUID(t)
	req := StartRequest{TenantID: a, IdempotencyKey: testUUID(t), DeviceID: testUUID(t), AssetID: testUUID(t)}
	first, err := s.Start(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.Start(ctx, req)
	if err != nil || again.SagaID != first.SagaID || again.Version != 1 || again.State != "reserving" {
		t.Fatalf("idempotent retry: first=%+v again=%+v err=%v", first, again, err)
	}
	changed := req
	changed.DeviceID = testUUID(t)
	if _, err := s.Start(ctx, changed); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("changed payload should conflict: %v", err)
	}
	assertStartEffects(t, ctx, pool, a, first.SagaID)
	assertTenantIsolation(t, ctx, pool, b, first.SagaID)
}

func assertStartEffects(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenant, sagaID string) {
	t.Helper()
	var sagas, commands, audit int
	if err := common.WithTenantSchema(ctx, pool, tenant, "", func(ctx context.Context, tx pgx.Tx) error {
		for _, item := range []struct {
			query string
			out   *int
		}{
			{"SELECT count(*) FROM provisioning_sagas WHERE tenant_id=$1 AND saga_id=$2", &sagas},
			{"SELECT count(*) FROM saga_command_outbox WHERE tenant_id=$1 AND saga_id=$2 AND step='asset.reserve'", &commands},
			{"SELECT count(*) FROM saga_audit WHERE tenant_id=$1 AND saga_id=$2", &audit},
		} {
			if err := tx.QueryRow(ctx, item.query, tenant, sagaID).Scan(item.out); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if sagas != 1 || commands != 1 || audit != 1 {
		t.Fatalf("start must commit one saga, command and audit: %d %d %d", sagas, commands, audit)
	}
}

func assertTenantIsolation(t *testing.T, ctx context.Context, pool *pgxpool.Pool, otherTenant, sagaID string) {
	t.Helper()
	var otherView int
	if err := common.WithTenantSchema(ctx, pool, otherTenant, "", func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, "SELECT count(*) FROM provisioning_sagas WHERE saga_id=$1", sagaID).Scan(&otherView)
	}); err != nil {
		t.Fatal(err)
	}
	if otherView != 0 {
		t.Fatalf("tenant B saw tenant A's saga: %d", otherView)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM provisioning_sagas WHERE saga_id=$1", sagaID).Scan(&otherView); err != nil || otherView != 0 {
		t.Fatalf("unscoped runtime read: count=%d err=%v", otherView, err)
	}
}

func TestLiveConcurrentAssetClaimHasOneWinner(t *testing.T) {
	pool := testPool(t)
	s := Store{DB: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tenant, asset := testUUID(t), testUUID(t)
	requests := [2]StartRequest{
		{TenantID: tenant, IdempotencyKey: testUUID(t), DeviceID: testUUID(t), AssetID: asset},
		{TenantID: tenant, IdempotencyKey: testUUID(t), DeviceID: testUUID(t), AssetID: asset},
	}
	var wg sync.WaitGroup
	var errs [2]error
	for i := range requests {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = s.Start(ctx, requests[i])
		}(i)
	}
	wg.Wait()
	if !((errs[0] == nil && errors.Is(errs[1], ErrAssetClaimed)) ||
		(errs[1] == nil && errors.Is(errs[0], ErrAssetClaimed))) {
		t.Fatalf("expected one winner and one asset conflict: %v, %v", errs[0], errs[1])
	}
}

func TestLiveConcurrentSameKeyReturnsOneSaga(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s := Store{DB: pool}
	req := StartRequest{TenantID: testUUID(t), IdempotencyKey: testUUID(t), DeviceID: testUUID(t), AssetID: testUUID(t)}
	var wg sync.WaitGroup
	var snapshots [2]Snapshot
	var errs [2]error
	for i := range snapshots {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			snapshots[i], errs[i] = s.Start(ctx, req)
		}(i)
	}
	wg.Wait()
	if errs[0] != nil || errs[1] != nil || snapshots[0].SagaID == "" || snapshots[0].SagaID != snapshots[1].SagaID {
		t.Fatalf("concurrent retry created different outcomes: %+v %+v, %v %v", snapshots[0], snapshots[1], errs[0], errs[1])
	}
	assertStartEffects(t, ctx, pool, req.TenantID, snapshots[0].SagaID)
}

func TestLiveResultCannotBorrowAnotherSagasCommand(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s := Store{DB: pool}
	tenant := testUUID(t)
	start := func() Snapshot {
		snap, err := s.Start(ctx, StartRequest{
			TenantID: tenant, IdempotencyKey: testUUID(t), DeviceID: testUUID(t), AssetID: testUUID(t),
		})
		if err != nil {
			t.Fatal(err)
		}
		return snap
	}
	first, second := start(), start()
	var otherCommand string
	if err := common.WithTenantSchema(ctx, pool, tenant, "", func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT command_id FROM saga_command_outbox
			WHERE tenant_id=$1 AND saga_id=$2`, tenant, second.SagaID).Scan(&otherCommand)
	}); err != nil {
		t.Fatal(err)
	}
	err := common.WithTenantSchema(ctx, pool, tenant, "", func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO saga_result_inbox
			(tenant_id, result_id, saga_id, command_id, outcome)
			VALUES ($1, $2, $3, $4, 'succeeded')`, tenant, testUUID(t), first.SagaID, otherCommand)
		return err
	})
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
		t.Fatalf("cross-saga command reference was accepted: %v", err)
	}
}
