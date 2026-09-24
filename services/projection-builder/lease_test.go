package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWriterLeaseFencesStaleHolder(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := replayTestDB(t, ctx)
	first, err := acquireWriterLease(ctx, pool, "read_v1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := acquireWriterLease(ctx, pool, "read_v1"); !errors.Is(err, ErrWriterLease) {
		t.Fatalf("concurrent writer accepted: %v", err)
	}
	if err := first.current(ctx); err != nil {
		t.Fatal(err)
	}
	if err := WithTenant(ctx, pool, infrastructureTenant, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE public.projection_writer_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND schema_name=$2`, infrastructureTenant, "read_v1")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	second, err := acquireWriterLease(ctx, pool, "read_v1")
	if err != nil {
		t.Fatal(err)
	}
	if second.epoch != first.epoch+1 {
		t.Fatalf("epoch did not advance: %d to %d", first.epoch, second.epoch)
	}
	if err := first.current(ctx); !errors.Is(err, ErrWriterLease) {
		t.Fatalf("stale writer accepted: %v", err)
	}
	if err := first.renew(ctx); !errors.Is(err, ErrWriterLease) {
		t.Fatalf("stale renewal accepted: %v", err)
	}
	if err := second.current(ctx); err != nil {
		t.Fatal(err)
	}
	staleStore := &Store{DB: pool, Schema: "read_v1", Lease: first}
	e := dbEvent(t, randomUUID(), randomUUID(), 1)
	if err := staleStore.Apply(ctx, message(e), e); !errors.Is(err, ErrWriterLease) {
		t.Fatalf("stale writer effect accepted: %v", err)
	}
}

func TestReadQueryCannotInspectWriterLease(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := replayTestDB(t, ctx)
	var database string
	if err := pool.QueryRow(ctx, `SELECT current_database()`).Scan(&database); err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.New(ctx, databaseURL(t, envOrSkip(t, "POSTGRES_ADMIN_URL"), database))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, `SET LOCAL ROLE read_query`); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.projection_writer_leases`).Scan(&count); err == nil {
		t.Fatal("read_query could inspect writer lease")
	}
}

func TestReplayLockIsScopedToVersion(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := replayTestDB(t, ctx)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7240512,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := acquireWriterLease(ctx, pool, "read_v1"); !errors.Is(err, ErrWriterLease) {
		t.Fatalf("same version not blocked: %v", err)
	}
	if _, err := acquireWriterLease(ctx, pool, "read_v2"); err != nil {
		t.Fatalf("unrelated version blocked: %v", err)
	}
}
