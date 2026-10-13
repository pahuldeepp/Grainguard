package common

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrInvalidTenant = errors.New("tenant identifier must be a lowercase, non-nil UUID")

var TenantPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var ShardPattern = regexp.MustCompile(`^s[1-4]$`)

// TenantPlacement is a route obtained from the authenticated placement authority.
// Epoch is serialized as decimal text at service boundaries to avoid JSON precision loss.
type TenantPlacement struct {
	TenantID       string
	ShardID        string
	Incarnation    string
	PlacementEpoch string
	State          string
	ExpiresAt      time.Time
}

type TxStarter interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

// WithTenantPlacement admits tenant SQL only after the local shard's durable
// ownership row has been locked and matched to the authority route. The SQL
// trigger fence repeats this check for every tenant-row mutation, so stale
// workers cannot bypass admission by skipping this helper.
func WithTenantPlacement(ctx context.Context, db TxStarter, route TenantPlacement, fn func(context.Context, pgx.Tx) error) error {
	if !TenantPattern.MatchString(route.TenantID) || !ShardPattern.MatchString(route.ShardID) ||
		!TenantPattern.MatchString(route.Incarnation) || !decimalEpochPattern.MatchString(route.PlacementEpoch) || route.State != "active" ||
		route.ExpiresAt.IsZero() {
		return ErrInvalidTenantPlacement
	}
	if epoch, err := strconv.ParseInt(route.PlacementEpoch, 10, 64); err != nil || epoch <= 0 {
		return ErrInvalidTenantPlacement
	}
	if observed := time.Now(); !observed.Before(route.ExpiresAt) {
		return placementExpiryError("before transaction begin", route.ExpiresAt, observed)
	}
	tx, err := db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin placed tenant transaction: %w", err)
	}
	if observed := time.Now(); !observed.Before(route.ExpiresAt) {
		return errors.Join(placementExpiryError("after transaction begin", route.ExpiresAt, observed), Rollback(tx))
	}
	defer func() {
		if r := recover(); r != nil {
			_ = Rollback(tx)
			panic(r)
		}
	}()
	for _, setting := range []struct{ name, value string }{
		{"app.tenant_id", route.TenantID},
		{"app.shard_id", route.ShardID},
		{"app.shard_incarnation", route.Incarnation},
		{"app.placement_epoch", route.PlacementEpoch},
	} {
		if _, err := tx.Exec(ctx, "SELECT set_config($1, $2, true)", setting.name, setting.value); err != nil {
			return errors.Join(fmt.Errorf("set placement context: %w", err), Rollback(tx))
		}
	}
	if _, err := tx.Exec(ctx, `SELECT greenguard_internal.admit_tenant_placement($1::uuid,$2::text,$3::uuid,$4::bigint)`, route.TenantID, route.ShardID, route.Incarnation, route.PlacementEpoch); err != nil {
		return errors.Join(ErrTenantAdmissionRejected, fmt.Errorf("admit tenant placement: %w", err), Rollback(tx))
	}
	if err := fn(ctx, tx); err != nil {
		return errors.Join(fmt.Errorf("placed tenant transaction: %w", err), Rollback(tx))
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit placed tenant transaction: %w", err)
	}
	return nil
}

// Keep expiry failures distinguishable in worker logs without exposing tenant
// identifiers or weakening the route check. Callers still match the same error.
func placementExpiryError(stage string, expiresAt, observedAt time.Time) error {
	return fmt.Errorf("%w: expired %s (expires_at=%s observed_at=%s)", ErrInvalidTenantPlacement,
		stage, expiresAt.UTC().Format(time.RFC3339Nano), observedAt.UTC().Format(time.RFC3339Nano))
}

var decimalEpochPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,18})$`)

var ErrInvalidTenantPlacement = errors.New("invalid tenant placement route")

// WithTenantSchema confines transaction-local tenant and optional projection schema settings.
func WithTenantSchema(ctx context.Context, db TxStarter, tenantID, schema string, fn func(context.Context, pgx.Tx) error) error {
	if !TenantPattern.MatchString(tenantID) {
		return ErrInvalidTenant
	}
	if router, ok := db.(TenantTransactionRouter); ok {
		return router.WithTenantSchema(ctx, tenantID, schema, fn)
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
