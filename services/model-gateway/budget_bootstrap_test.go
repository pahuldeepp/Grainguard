package modelgateway

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

const validBudgetCaps = `{"platform":{"limit_micros":1000000,"limit_tokens":100000},"tenants":[{"tenant_id":"123e4567-e89b-42d3-a456-426614174000","limit":{"limit_micros":500000,"limit_tokens":50000},"users":[{"principal_id":"123e4567-e89b-42d3-a456-426614174001","limit":{"limit_micros":100000,"limit_tokens":10000}}]}]}`

func TestParseBudgetCapsAcceptsExplicitCanonicalScopes(t *testing.T) {
	caps, err := ParseBudgetCaps([]byte(validBudgetCaps))
	if err != nil {
		t.Fatal(err)
	}
	if len(caps.Tenants) != 1 || caps.Tenants[0].Users[0].PrincipalID != "123e4567-e89b-42d3-a456-426614174001" {
		t.Fatalf("unexpected parsed cap configuration: %#v", caps)
	}
}

func TestParseBudgetCapsRejectsUnsafeOrAmbiguousInput(t *testing.T) {
	tests := []struct{ name, input string }{
		{"missing cap field", `{"platform":{"limit_micros":1},"tenants":[{"tenant_id":"123e4567-e89b-42d3-a456-426614174000","limit":{"limit_micros":1,"limit_tokens":1}}]}`},
		{"unknown field", strings.Replace(validBudgetCaps, `"tenants"`, `"unknown":true,"tenants"`, 1)},
		{"duplicate field", strings.Replace(validBudgetCaps, `"limit_micros":1000000`, `"limit_micros":1000000,"limit_micros":1`, 1)},
		{"uppercase UUID", strings.Replace(validBudgetCaps, "123e4567-e89b-42d3-a456-426614174000", "123E4567-e89b-42d3-a456-426614174000", 1)},
		{"duplicate tenant", strings.Replace(validBudgetCaps, `]}]}`, `]},{"tenant_id":"123e4567-e89b-42d3-a456-426614174000","limit":{"limit_micros":1,"limit_tokens":1}}]}`, 1)},
		{"negative cap", strings.Replace(validBudgetCaps, `"limit_micros":1000000`, `"limit_micros":-1`, 1)},
		{"oversized cap", strings.Replace(validBudgetCaps, `"limit_micros":1000000`, `"limit_micros":1000000000000001`, 1)},
		{"trailing data", validBudgetCaps + `{}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := ParseBudgetCaps([]byte(tt.input)); err == nil {
				t.Fatal("expected input rejection")
			}
		})
	}
}

func TestParseBudgetCapsDoesNotAcceptEmptyProvisioningSet(t *testing.T) {
	if _, err := ParseBudgetCaps([]byte(`{"platform":{"limit_micros":1,"limit_tokens":1},"tenants":[]}`)); err == nil {
		t.Fatal("expected empty tenant configuration rejection")
	}
}

func TestApplyBudgetCapsFixturePreservesUsageAndRejectsUnsafeDecrease(t *testing.T) {
	dsn := os.Getenv("MODEL_GATEWAY_BUDGET_FIXTURE_DSN")
	if dsn == "" {
		t.Skip("local PostgreSQL acceptance sets MODEL_GATEWAY_BUDGET_FIXTURE_DSN")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal("fixture database connection failed")
	}
	defer conn.Close(context.Background())
	initial, err := ParseBudgetCaps([]byte(validBudgetCaps))
	if err != nil {
		t.Fatal(err)
	}
	if err := applyBudgetCapsConn(ctx, conn, initial); err != nil {
		t.Fatal(err)
	}
	tenant := initial.Tenants[0]
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal("fixture transaction failed")
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenant.TenantID); err == nil {
		_, err = tx.Exec(ctx, `UPDATE ai_budget_accounts SET held_micros=123,spent_micros=234,held_tokens=12,spent_tokens=23
			WHERE tenant_id=$1 AND scope IN ('tenant','user:123e4567-e89b-42d3-a456-426614174001')`, tenant.TenantID)
	}
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE ai_platform_budget SET held_micros=123,spent_micros=234,held_tokens=12,spent_tokens=23
			WHERE period=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`)
	}
	if err == nil {
		err = tx.Commit(ctx)
	} else {
		_ = tx.Rollback(ctx)
	}
	if err != nil {
		t.Fatal("fixture usage seed failed")
	}
	increased := initial
	increased.Platform.LimitMicros = 2_000_000
	increased.Platform.LimitTokens = 200_000
	increased.Tenants[0].Limit.LimitMicros = 600_000
	increased.Tenants[0].Limit.LimitTokens = 60_000
	increased.Tenants[0].Users[0].Limit.LimitMicros = 200_000
	increased.Tenants[0].Users[0].Limit.LimitTokens = 20_000
	if err := applyBudgetCapsConn(ctx, conn, increased); err != nil {
		t.Fatal(err)
	}
	var held, spent int64
	if err := readTenantBudget(ctx, conn, tenant.TenantID, &held, &spent); err != nil || held != 123 || spent != 234 {
		t.Fatalf("cap update lost tenant usage: held=%d spent=%d err=%v", held, spent, err)
	}
	decreased := increased
	decreased.Tenants[0].Limit.LimitMicros = 300
	if err := applyBudgetCapsConn(ctx, conn, decreased); err == nil {
		t.Fatal("expected cap below held+spent to be rejected")
	}
	if err := readTenantBudgetLimit(ctx, conn, tenant.TenantID, &held); err != nil || held != 600_000 {
		t.Fatalf("failed decrease changed existing cap: cap=%d err=%v", held, err)
	}
}

func readTenantBudget(ctx context.Context, conn *pgx.Conn, tenant string, held, spent *int64) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenant); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `SELECT held_micros,spent_micros FROM ai_budget_accounts
		WHERE tenant_id=$1 AND scope='tenant' AND period=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`, tenant).Scan(held, spent); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func readTenantBudgetLimit(ctx context.Context, conn *pgx.Conn, tenant string, limit *int64) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenant); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `SELECT limit_micros FROM ai_budget_accounts
		WHERE tenant_id=$1 AND scope='tenant' AND period=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`, tenant).Scan(limit); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
