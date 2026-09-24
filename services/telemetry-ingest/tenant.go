package main

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrInvalidTenant = errors.New("tenant identifier must be a lowercase, non-nil UUID")

var tenantPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

const rollbackTimeout = 5 * time.Second

type TxStarter interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

func WithTenant(ctx context.Context, db TxStarter, tenantID string, fn func(ctx context.Context, tx pgx.Tx) error) error {
	if !tenantPattern.MatchString(tenantID) {
		return ErrInvalidTenant
	}
	tx, err := db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin tenant transaction: %w", err)
	}
	defer func() {
		if r := recover(); r != nil {
			_ = rollback(tx)
			panic(r)
		}
	}()
	// set_config(..., true) is transaction-local, so the tenant cannot leak to the next user of a pooled connection.
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return errors.Join(fmt.Errorf("set tenant context: %w", err), rollback(tx))
	}
	if err := fn(ctx, tx); err != nil {
		return errors.Join(fmt.Errorf("tenant transaction: %w", err), rollback(tx))
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tenant transaction: %w", err)
	}
	return nil
}

// WithoutCancel so a cancelled request still releases the connection cleanly.
func rollback(tx pgx.Tx) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), rollbackTimeout)
	defer cancel()
	return tx.Rollback(ctx)
}
