package main

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const testTenant = "3f2b8c1e-9a4d-4e7b-8c55-1d2e3f4a5b6c"

type fakeTx struct {
	pgx.Tx
	execErr, commitErr, rollbackErr error
	execSQL                         string
	execArgs                        []any
	commits, rollbacks              int
	rollbackCtxErr                  error
	rollbackHasDeadline             bool
}

func (f *fakeTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.execSQL, f.execArgs = sql, args
	return pgconn.CommandTag{}, f.execErr
}

func (f *fakeTx) Commit(context.Context) error {
	f.commits++
	return f.commitErr
}

func (f *fakeTx) Rollback(ctx context.Context) error {
	f.rollbacks++
	f.rollbackCtxErr = ctx.Err()
	_, f.rollbackHasDeadline = ctx.Deadline()
	return f.rollbackErr
}

type fakeDB struct {
	tx       *fakeTx
	beginErr error
	begins   int
	opts     pgx.TxOptions
}

func (f *fakeDB) BeginTx(_ context.Context, opts pgx.TxOptions) (pgx.Tx, error) {
	f.begins++
	f.opts = opts
	if f.beginErr != nil {
		return nil, f.beginErr
	}
	return f.tx, nil
}

func noop(context.Context, pgx.Tx) error { return nil }

func TestWithTenantRejectsInvalidTenant(t *testing.T) {
	for _, id := range []string{
		"",
		"3F2B8C1E-9A4D-4E7B-8C55-1D2E3F4A5B6C",
		"not-a-uuid",
		"00000000-0000-0000-0000-000000000000",
		"' OR 1=1; --",
		testTenant + "x",
	} {
		db := &fakeDB{tx: &fakeTx{}}
		called := false
		err := WithTenant(context.Background(), db, id, func(context.Context, pgx.Tx) error { called = true; return nil })
		if !errors.Is(err, ErrInvalidTenant) || db.begins != 0 || called {
			t.Errorf("%q: err=%v begins=%d called=%v", id, err, db.begins, called)
		}
	}
}

func TestWithTenantBeginFailure(t *testing.T) {
	boom := errors.New("begin boom")
	db := &fakeDB{beginErr: boom}
	if err := WithTenant(context.Background(), db, testTenant, noop); !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
}

func TestWithTenantSetConfigFailure(t *testing.T) {
	boom := errors.New("set_config boom")
	tx := &fakeTx{execErr: boom}
	called := false
	err := WithTenant(context.Background(), &fakeDB{tx: tx}, testTenant, func(context.Context, pgx.Tx) error { called = true; return nil })
	if !errors.Is(err, boom) || called || tx.rollbacks != 1 || tx.commits != 0 {
		t.Fatalf("err=%v called=%v rollbacks=%d commits=%d", err, called, tx.rollbacks, tx.commits)
	}
}

func TestWithTenantSetsTransactionLocalTenant(t *testing.T) {
	tx := &fakeTx{}
	db := &fakeDB{tx: tx}
	if err := WithTenant(context.Background(), db, testTenant, noop); err != nil {
		t.Fatal(err)
	}
	if tx.execSQL != "SELECT set_config('app.tenant_id', $1, true)" {
		t.Errorf("sql = %q", tx.execSQL)
	}
	if len(tx.execArgs) != 1 || tx.execArgs[0] != testTenant {
		t.Errorf("args = %v", tx.execArgs)
	}
	if db.opts != (pgx.TxOptions{}) || tx.commits != 1 || tx.rollbacks != 0 {
		t.Errorf("opts=%v commits=%d rollbacks=%d", db.opts, tx.commits, tx.rollbacks)
	}
}

func TestWithTenantFnErrorRollsBack(t *testing.T) {
	boom := errors.New("fn boom")
	tx := &fakeTx{}
	err := WithTenant(context.Background(), &fakeDB{tx: tx}, testTenant, func(context.Context, pgx.Tx) error { return boom })
	if !errors.Is(err, boom) || tx.rollbacks != 1 || tx.commits != 0 {
		t.Fatalf("err=%v rollbacks=%d commits=%d", err, tx.rollbacks, tx.commits)
	}
}

func TestWithTenantRollbackErrorDoesNotMaskOriginal(t *testing.T) {
	boom, rb := errors.New("fn boom"), errors.New("rollback boom")
	tx := &fakeTx{rollbackErr: rb}
	err := WithTenant(context.Background(), &fakeDB{tx: tx}, testTenant, func(context.Context, pgx.Tx) error { return boom })
	if !errors.Is(err, boom) || !errors.Is(err, rb) {
		t.Fatalf("got %v", err)
	}
}

func TestWithTenantPanicRollsBackAndRepanics(t *testing.T) {
	tx := &fakeTx{}
	defer func() {
		if r := recover(); r != "kaboom" || tx.rollbacks != 1 || tx.commits != 0 {
			t.Fatalf("recovered=%v rollbacks=%d commits=%d", r, tx.rollbacks, tx.commits)
		}
	}()
	_ = WithTenant(context.Background(), &fakeDB{tx: tx}, testTenant, func(context.Context, pgx.Tx) error { panic("kaboom") })
}

func TestWithTenantCommitFailure(t *testing.T) {
	boom := errors.New("commit boom")
	tx := &fakeTx{commitErr: boom}
	err := WithTenant(context.Background(), &fakeDB{tx: tx}, testTenant, noop)
	if !errors.Is(err, boom) || tx.rollbacks != 0 {
		t.Fatalf("err=%v rollbacks=%d", err, tx.rollbacks)
	}
}

func TestWithTenantRollbackSurvivesCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	tx := &fakeTx{}
	err := WithTenant(ctx, &fakeDB{tx: tx}, testTenant, func(context.Context, pgx.Tx) error {
		cancel()
		return context.Canceled
	})
	if !errors.Is(err, context.Canceled) || tx.rollbacks != 1 {
		t.Fatalf("err=%v rollbacks=%d", err, tx.rollbacks)
	}
	if tx.rollbackCtxErr != nil || !tx.rollbackHasDeadline {
		t.Errorf("rollback ctx err=%v deadline=%v", tx.rollbackCtxErr, tx.rollbackHasDeadline)
	}
}

func TestWithTenantDoesNotLeakOnPooledConnection(t *testing.T) {
	url := os.Getenv("TELEMETRY_DATABASE_URL")
	if url == "" {
		t.Skip("TELEMETRY_DATABASE_URL is not set")
	}
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	configureFixturePlacement(t, config)
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	const query = "SELECT coalesce(current_setting('app.tenant_id', true), '')"
	read := func(q interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}) string {
		var got string
		if err := q.QueryRow(ctx, query).Scan(&got); err != nil {
			t.Fatal(err)
		}
		return got
	}

	if err := WithTenant(ctx, pool, testTenant, func(ctx context.Context, tx pgx.Tx) error {
		if got := read(tx); got != testTenant {
			t.Errorf("inside tenant = %q", got)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if got := read(pool); got != "" {
		t.Errorf("leaked after success: %q", got)
	}

	boom := errors.New("boom")
	err = WithTenant(ctx, pool, testTenant, func(ctx context.Context, tx pgx.Tx) error {
		if got := read(tx); got != testTenant {
			t.Errorf("inside tenant = %q", got)
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
	if got := read(pool); got != "" {
		t.Errorf("leaked after error: %q", got)
	}
}

type failingDB struct{}

func (failingDB) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) {
	return nil, errors.New("database unavailable")
}
