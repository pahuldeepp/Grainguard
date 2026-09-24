package common

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrInvalidTenant = errors.New("tenant identifier must be a lowercase, non-nil UUID")

var TenantPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type TxStarter interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

// WithTenantSchema confines transaction-local tenant and optional projection schema settings.
func WithTenantSchema(ctx context.Context, db TxStarter, tenantID, schema string, fn func(context.Context, pgx.Tx) error) error {
	if !TenantPattern.MatchString(tenantID) {
		return ErrInvalidTenant
	}
	tx, err := db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin tenant transaction: %w", err)
	}
	defer func() {
		if r := recover(); r != nil {
			_ = Rollback(tx)
			panic(r)
		}
	}()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return errors.Join(fmt.Errorf("set tenant context: %w", err), Rollback(tx))
	}
	if schema != "" && schema != "public" {
		if _, err := tx.Exec(ctx, "SELECT set_config('search_path', $1, true)", schema+",pg_catalog"); err != nil {
			return errors.Join(fmt.Errorf("set projection schema: %w", err), Rollback(tx))
		}
	}
	if err := fn(ctx, tx); err != nil {
		return errors.Join(fmt.Errorf("tenant transaction: %w", err), Rollback(tx))
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tenant transaction: %w", err)
	}
	return nil
}

func Rollback(tx pgx.Tx) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), 5*time.Second)
	defer cancel()
	return tx.Rollback(ctx)
}
