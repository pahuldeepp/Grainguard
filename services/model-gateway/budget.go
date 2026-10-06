package modelgateway

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Charge struct {
	TenantID, PrincipalID, ID, Model, Provider string
	Tokens, Micros                             int64
}
type BudgetStore interface {
	Reserve(context.Context, Charge) error
	Settle(context.Context, Charge, int64, int64, bool) error
}
type PostgresBudget struct{ Pool *pgxpool.Pool }

func (b *PostgresBudget) transaction(ctx context.Context, tenant string) (pgx.Tx, error) {
	tx, err := b.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "SELECT set_config('app.tenant_id',$1,true)", tenant); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}
func (b *PostgresBudget) Reserve(ctx context.Context, c Charge) error {
	if c.Micros < 0 || c.Tokens < 0 {
		return errors.New("negative reservation")
	}
	tx, err := b.transaction(ctx, c.TenantID)
	if err != nil {
		return &ControlError{"budget_unavailable", 503, 1}
	}
	defer tx.Rollback(ctx)
	var globalMoney, globalTokens int64
	err = tx.QueryRow(ctx, `SELECT limit_micros-held_micros-spent_micros,limit_tokens-held_tokens-spent_tokens FROM ai_platform_budget WHERE period=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date FOR UPDATE NOWAIT`).Scan(&globalMoney, &globalTokens)
	if errors.Is(err, pgx.ErrNoRows) {
		return &ControlError{"platform_budget_not_provisioned", 429, 60}
	}
	if err != nil {
		return budgetFailure(err)
	}
	if c.Micros > globalMoney || c.Tokens > globalTokens {
		return &ControlError{"platform_budget_exhausted", 429, 60}
	}
	_, err = tx.Exec(ctx, `UPDATE ai_platform_budget SET held_micros=held_micros+$1,held_tokens=held_tokens+$2,version=version+1 WHERE period=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`, c.Micros, c.Tokens)
	if err != nil {
		return &ControlError{"budget_unavailable", 503, 1}
	}
	// Pessimistic row locks: tenant first, then user. Caps are provisioned by a
	// separate owner; runtime cannot create accounts or increase their limits.
	scopes := []string{"tenant"}
	if c.PrincipalID != "" {
		scopes = append(scopes, "user:"+c.PrincipalID)
	}
	for _, scope := range scopes {
		var capMoney, heldMoney, spentMoney, capTokens, heldTokens, spentTokens int64
		err = tx.QueryRow(ctx, `SELECT limit_micros,held_micros,spent_micros,limit_tokens,held_tokens,spent_tokens FROM ai_budget_accounts WHERE tenant_id=$1 AND scope=$2 AND period=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date FOR UPDATE NOWAIT`, c.TenantID, scope).Scan(&capMoney, &heldMoney, &spentMoney, &capTokens, &heldTokens, &spentTokens)
		if errors.Is(err, pgx.ErrNoRows) {
			return &ControlError{"budget_not_provisioned", 429, 60}
		}
		if err != nil {
			return budgetFailure(err)
		}
		if c.Micros < 0 || c.Tokens < 0 {
			return errors.New("negative reservation")
		}
		if c.Micros > capMoney-heldMoney-spentMoney || c.Tokens > capTokens-heldTokens-spentTokens {
			return &ControlError{"budget_exhausted", 429, 60}
		}
		if _, err = tx.Exec(ctx, `UPDATE ai_budget_accounts SET held_micros=held_micros+$3,held_tokens=held_tokens+$4,version=version+1 WHERE tenant_id=$1 AND scope=$2 AND period=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`, c.TenantID, scope, c.Micros, c.Tokens); err != nil {
			return &ControlError{"budget_unavailable", 503, 1}
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO ai_budget_attempts(tenant_id,id,principal_id,model,provider,period,reserved_micros,reserved_tokens) VALUES($1,$2,$3,$4,$5,date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,$6,$7)`, c.TenantID, c.ID, c.PrincipalID, c.Model, c.Provider, c.Micros, c.Tokens)
	if err != nil {
		return &ControlError{"budget_unavailable", 503, 1}
	}
	if err = tx.Commit(ctx); err != nil {
		return &ControlError{"budget_unavailable", 503, 1}
	}
	return nil
}
func (b *PostgresBudget) Settle(ctx context.Context, c Charge, tokens, micros int64, known bool) error {
	if tokens < 0 || micros < 0 || tokens > c.Tokens || micros > c.Micros {
		known = false
	}
	if !known {
		tokens, micros = c.Tokens, c.Micros
	}
	tx, err := b.transaction(ctx, c.TenantID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var state string
	var period time.Time
	var reservedTokens, reservedMicros int64
	var principal string
	err = tx.QueryRow(ctx, `SELECT state,period,reserved_tokens,reserved_micros,principal_id FROM ai_budget_attempts WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, c.TenantID, c.ID).Scan(&state, &period, &reservedTokens, &reservedMicros, &principal)
	if err != nil {
		return err
	}
	if state != "held" {
		return tx.Commit(ctx)
	}
	if reservedTokens != c.Tokens || reservedMicros != c.Micros || principal != c.PrincipalID {
		return errors.New("budget reservation mismatch")
	}
	_, err = tx.Exec(ctx, `UPDATE ai_platform_budget SET held_micros=held_micros-$2,held_tokens=held_tokens-$3,spent_micros=spent_micros+$4,spent_tokens=spent_tokens+$5,version=version+1 WHERE period=$1`, period, c.Micros, c.Tokens, micros, tokens)
	if err != nil {
		return err
	}
	scopes := []string{"tenant"}
	if principal != "" {
		scopes = append(scopes, "user:"+principal)
	}
	for _, scope := range scopes {
		_, err = tx.Exec(ctx, `UPDATE ai_budget_accounts SET held_micros=held_micros-$4,held_tokens=held_tokens-$5,spent_micros=spent_micros+$6,spent_tokens=spent_tokens+$7,version=version+1 WHERE tenant_id=$1 AND scope=$2 AND period=$3`, c.TenantID, scope, period, c.Micros, c.Tokens, micros, tokens)
		if err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE ai_budget_attempts SET state='settled',spent_tokens=$3,spent_micros=$4,usage_known=$5,settled_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND id=$2`, c.TenantID, c.ID, tokens, micros, known)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"attempt_id": c.ID, "model": c.Model, "provider": c.Provider, "tokens": tokens, "micros": micros, "usage_known": known})
	_, err = tx.Exec(ctx, `INSERT INTO ai_usage_outbox(tenant_id,id,payload) VALUES($1,$2,$3)`, c.TenantID, c.ID, payload)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ReapTenant retains the worst-case charge after a crashed process. RLS and an
// explicit tenant predicate apply; no expired reservation is silently refunded.
func (b *PostgresBudget) ReapTenant(ctx context.Context, tenant string, age time.Duration) error {
	tx, err := b.transaction(ctx, tenant)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id,principal_id,model,provider,reserved_tokens,reserved_micros FROM ai_budget_attempts WHERE tenant_id=$1 AND state='held' AND created_at<CURRENT_TIMESTAMP-($2*interval '1 second') ORDER BY created_at LIMIT 100`, tenant, int(age.Seconds()))
	if err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	var charges []Charge
	for rows.Next() {
		c := Charge{TenantID: tenant}
		if err = rows.Scan(&c.ID, &c.PrincipalID, &c.Model, &c.Provider, &c.Tokens, &c.Micros); err != nil {
			break
		}
		charges = append(charges, c)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	_ = tx.Rollback(ctx)
	if err != nil {
		return err
	}
	for _, c := range charges {
		if err = b.Settle(ctx, c, 0, 0, false); err != nil {
			return err
		}
	}
	return nil
}

func budgetFailure(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "55P03" {
		return &ControlError{"budget_busy", 429, 1}
	}
	return &ControlError{"budget_unavailable", 503, 1}
}
