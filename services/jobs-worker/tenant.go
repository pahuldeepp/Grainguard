package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
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
	if routed, ok := db.(common.TenantTransactionRouter); ok {
		return routed.WithTenantSchema(ctx, tenantID, "", fn)
	}
	return inTx(ctx, db, "app.tenant_id", tenantID, fn)
}

// withoutTenant runs fn in a transaction with no tenant context. RLS then hides every tenant
// row; it is used only to call the ID-only selectors (migration 000005) and to write the
// non-tenant quarantine table.
func withoutTenant(ctx context.Context, db TxStarter, fn func(context.Context, pgx.Tx) error) error {
	if shards, ok := db.(*common.ShardedDB); ok {
		// Poison transport records have no authenticated customer tenant. The
		// explicit s1 infrastructure ledger owns these source coordinates.
		return inTx(ctx, shards.InfrastructureDB("s1"), "", "", fn)
	}
	return inTx(ctx, db, "", "", fn)
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
	if err := setContext(ctx, tx, key, value); err != nil {
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

func setContext(ctx context.Context, tx pgx.Tx, key, value string) error {
	if key == "" {
		return nil
	}
	_, err := tx.Exec(ctx, "SELECT set_config($1, $2, true)", key, value)
	return err
}

// selectorMax mirrors the 1..1000 clamp inside the migration 000005 selectors.
const selectorMax = 1000

// selectRefs calls one ID-only selector with no tenant context and scans its rows.
func selectRefs[T any](ctx context.Context, db TxStarter, sql string, limit int, scan func(pgx.CollectableRow) (T, error)) ([]T, error) {
	if shards, ok := db.(*common.ShardedDB); ok {
		var refs []T
		err := shards.ForEachPrimary(ctx, func(shard string, _ *pgxpool.Pool) error {
			page, err := selectRefs(ctx, shards.InfrastructureDB(shard), sql, limit, scan)
			refs = append(refs, page...)
			return err
		})
		return refs, err
	}
	var refs []T
	err := withoutTenant(ctx, db, func(ctx context.Context, tx pgx.Tx) error {
		rows, err := tx.Query(ctx, sql, min(max(limit, 1), selectorMax))
		if err != nil {
			return err
		}
		refs, err = pgx.CollectRows(rows, scan)
		return err
	})
	return refs, err
}
