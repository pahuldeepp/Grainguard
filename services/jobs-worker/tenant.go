package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrInvalidTenant = errors.New("tenant identifier must be a lowercase UUID")

const rollbackTimeout = 5 * time.Second

type TxStarter interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

// WithTenant runs fn in one transaction whose tenant context is transaction-local
// (set_config(..., true)), so it cannot leak through PgBouncer transaction pooling.
func WithTenant(ctx context.Context, db TxStarter, tenantID string, fn func(context.Context, pgx.Tx) error) error {
	if !uuidPattern.MatchString(tenantID) || tenantID == "00000000-0000-0000-0000-000000000000" {
		return ErrInvalidTenant
	}
	return inTx(ctx, db, "app.tenant_id", tenantID, fn)
}

// withDispatchScan opens the read-only cross-tenant scan context used only to list due
// outbox identifiers (see the dispatch_scan policy in migration 000001).
func withDispatchScan(ctx context.Context, db TxStarter, fn func(context.Context, pgx.Tx) error) error {
	return inTx(ctx, db, "app.scope", "dispatch-scan", fn)
}

func inTx(ctx context.Context, db TxStarter, key, value string, fn func(context.Context, pgx.Tx) error) error {
	tx, err := db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer func() {
		if r := recover(); r != nil {
			_ = rollback(tx)
			panic(r)
		}
	}()
	if _, err := tx.Exec(ctx, "SELECT set_config($1, $2, true)", key, value); err != nil {
		return errors.Join(fmt.Errorf("set context: %w", err), rollback(tx))
	}
	if err := fn(ctx, tx); err != nil {
		return errors.Join(err, rollback(tx))
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

func rollback(tx pgx.Tx) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), rollbackTimeout)
	defer cancel()
	return tx.Rollback(ctx)
}
