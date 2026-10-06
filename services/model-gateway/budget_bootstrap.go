package modelgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"

	"github.com/jackc/pgx/v5"
)

const maxConfiguredBudget = int64(1_000_000_000_000_000)

var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// BudgetCaps is the complete set of caps to ensure for the current UTC month.
// Omitting a tenant or user never deletes its row or usage history.
type BudgetCaps struct {
	Platform BudgetLimit  `json:"platform"`
	Tenants  []TenantCaps `json:"tenants"`
}

type BudgetLimit struct {
	LimitMicros int64 `json:"limit_micros"`
	LimitTokens int64 `json:"limit_tokens"`
}

type TenantCaps struct {
	TenantID string      `json:"tenant_id"`
	Limit    BudgetLimit `json:"limit"`
	Users    []UserCaps  `json:"users,omitempty"`
}

type UserCaps struct {
	PrincipalID string      `json:"principal_id"`
	Limit       BudgetLimit `json:"limit"`
}

// ParseBudgetCaps rejects ambiguous/oversized cap documents before connecting to
// the database. Identity IDs are canonical UUIDs, matching membership identityKey.
func ParseBudgetCaps(data []byte) (BudgetCaps, error) {
	var caps BudgetCaps
	if len(data) == 0 || len(data) > 1<<20 {
		return caps, errors.New("budget cap document size is invalid")
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return caps, errors.New("budget cap document contains duplicate or malformed JSON keys")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&caps); err != nil {
		return caps, errors.New("budget cap document is invalid")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return caps, errors.New("budget cap document has trailing data")
	}
	var shape map[string]json.RawMessage
	if err := json.Unmarshal(data, &shape); err != nil || len(shape) != 2 || shape["platform"] == nil || shape["tenants"] == nil {
		return BudgetCaps{}, errors.New("budget cap document must define platform and tenants")
	}
	var platform map[string]json.RawMessage
	if err := json.Unmarshal(shape["platform"], &platform); err != nil || len(platform) != 2 || platform["limit_micros"] == nil || platform["limit_tokens"] == nil {
		return BudgetCaps{}, errors.New("platform budget must define both limits")
	}
	var tenants []map[string]json.RawMessage
	if err := json.Unmarshal(shape["tenants"], &tenants); err != nil {
		return BudgetCaps{}, errors.New("tenant budgets must be an array")
	}
	for _, tenant := range tenants {
		if _, hasID := tenant["tenant_id"]; !hasID {
			return BudgetCaps{}, errors.New("tenant budget is missing tenant_id")
		}
		if _, hasLimit := tenant["limit"]; !hasLimit {
			return BudgetCaps{}, errors.New("tenant budget is missing limit")
		}
		var limit map[string]json.RawMessage
		if err := json.Unmarshal(tenant["limit"], &limit); err != nil || len(limit) != 2 || limit["limit_micros"] == nil || limit["limit_tokens"] == nil {
			return BudgetCaps{}, errors.New("tenant and user budgets must define both limits")
		}
		if usersRaw, ok := tenant["users"]; ok {
			var users []map[string]json.RawMessage
			if err := json.Unmarshal(usersRaw, &users); err != nil {
				return BudgetCaps{}, errors.New("user budgets must be an array")
			}
			for _, user := range users {
				var userLimit map[string]json.RawMessage
				if user["principal_id"] == nil || json.Unmarshal(user["limit"], &userLimit) != nil || len(userLimit) != 2 || userLimit["limit_micros"] == nil || userLimit["limit_tokens"] == nil {
					return BudgetCaps{}, errors.New("user budget is missing its identity or limits")
				}
			}
		}
	}
	if err := caps.Validate(); err != nil {
		return BudgetCaps{}, err
	}
	return caps, nil
}

func rejectDuplicateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var scan func() error
	scan = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]struct{}{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return errors.New("object key is not a string")
				}
				if _, exists := seen[key]; exists {
					return errors.New("duplicate object key")
				}
				seen[key] = struct{}{}
				if err := scan(); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim('}') {
				return errors.New("unterminated object")
			}
		case '[':
			for decoder.More() {
				if err := scan(); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim(']') {
				return errors.New("unterminated array")
			}
		default:
			return errors.New("unexpected JSON delimiter")
		}
		return nil
	}
	if err := scan(); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("trailing JSON token")
	}
	return nil
}

func (c BudgetCaps) Validate() error {
	if err := validateBudgetLimit(c.Platform); err != nil {
		return fmt.Errorf("platform budget is invalid: %w", err)
	}
	if len(c.Tenants) == 0 || len(c.Tenants) > 5000 {
		return errors.New("budget document must contain 1 to 5000 tenants")
	}
	seenTenants := make(map[string]struct{}, len(c.Tenants))
	userCount := 0
	for _, tenant := range c.Tenants {
		if !canonicalUUID.MatchString(tenant.TenantID) {
			return errors.New("tenant IDs must be canonical lowercase UUIDs")
		}
		if _, exists := seenTenants[tenant.TenantID]; exists {
			return errors.New("budget document contains a duplicate tenant")
		}
		seenTenants[tenant.TenantID] = struct{}{}
		if err := validateBudgetLimit(tenant.Limit); err != nil {
			return fmt.Errorf("tenant budget is invalid: %w", err)
		}
		seenUsers := make(map[string]struct{}, len(tenant.Users))
		for _, user := range tenant.Users {
			userCount++
			if userCount > 25000 || !canonicalUUID.MatchString(user.PrincipalID) {
				return errors.New("user IDs must be canonical UUIDs and total no more than 25000")
			}
			if _, exists := seenUsers[user.PrincipalID]; exists {
				return errors.New("tenant budget contains a duplicate user")
			}
			seenUsers[user.PrincipalID] = struct{}{}
			if err := validateBudgetLimit(user.Limit); err != nil {
				return fmt.Errorf("user budget is invalid: %w", err)
			}
		}
	}
	return nil
}

func validateBudgetLimit(limit BudgetLimit) error {
	if limit.LimitMicros < 0 || limit.LimitTokens < 0 || limit.LimitMicros > maxConfiguredBudget || limit.LimitTokens > maxConfiguredBudget {
		return errors.New("limits must be between zero and 1000000000000000")
	}
	return nil
}

// ApplyBudgetCaps provisions the current-month global, tenant and user rows in
// one transaction. It uses the migration role only after verifying its database,
// role flags, table ownership, and forced RLS contract. No held/spent counters
// are changed. A new cap below committed usage is rejected by each upsert.
func ApplyBudgetCaps(ctx context.Context, dsn, expectedHost string, caps BudgetCaps) error {
	if err := caps.Validate(); err != nil {
		return err
	}
	if err := ValidateMigrationDSN(dsn, expectedHost); err != nil {
		return err
	}
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return errors.New("cannot connect to configured budget database")
	}
	defer conn.Close(context.Background())
	return applyBudgetCapsConn(ctx, conn, caps)
}

func applyBudgetCapsConn(ctx context.Context, conn *pgx.Conn, caps BudgetCaps) error {
	var database, role string
	if err := conn.QueryRow(ctx, "SELECT current_database(),current_user").Scan(&database, &role); err != nil || database != "greenguard_ai_usage" || role != "model_gateway_migrator" {
		return errors.New("budget bootstrap connection identity mismatch")
	}
	var unsafe bool
	if err := conn.QueryRow(ctx, "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user").Scan(&unsafe); err != nil || unsafe {
		return errors.New("budget bootstrap role must not be superuser or bypass RLS")
	}
	var owned int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
		WHERE n.nspname='public' AND c.relname IN ('ai_platform_budget','ai_budget_accounts')
		AND c.relowner=current_user::regrole`).Scan(&owned); err != nil || owned != 2 {
		return errors.New("budget bootstrap role must own the budget tables")
	}
	var rls int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
		WHERE n.nspname='public' AND c.relname IN ('ai_budget_accounts','ai_budget_attempts','ai_usage_outbox')
		AND c.relrowsecurity AND c.relforcerowsecurity`).Scan(&rls); err != nil || rls != 3 {
		return errors.New("budget tables must have forced row level security")
	}

	tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return errors.New("cannot start budget bootstrap transaction")
	}
	defer tx.Rollback(ctx)
	var period string
	if err := tx.QueryRow(ctx, `SELECT date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date::text`).Scan(&period); err != nil {
		return errors.New("cannot determine current UTC budget period")
	}
	if err := ensurePlatformBudget(ctx, tx, period, caps.Platform); err != nil {
		return err
	}
	for _, tenant := range caps.Tenants {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenant.TenantID); err != nil {
			return errors.New("cannot set tenant budget scope")
		}
		if err := ensureTenantBudget(ctx, tx, period, tenant.TenantID, "tenant", tenant.Limit); err != nil {
			return err
		}
		for _, user := range tenant.Users {
			if err := ensureTenantBudget(ctx, tx, period, tenant.TenantID, "user:"+user.PrincipalID, user.Limit); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("budget caps could not be committed")
	}
	return nil
}

func ensurePlatformBudget(ctx context.Context, tx pgx.Tx, period string, limit BudgetLimit) error {
	var updated int
	err := tx.QueryRow(ctx, `INSERT INTO ai_platform_budget(period,limit_micros,limit_tokens)
		VALUES($1,$2,$3) ON CONFLICT(period) DO UPDATE SET limit_micros=EXCLUDED.limit_micros,
		limit_tokens=EXCLUDED.limit_tokens,version=ai_platform_budget.version+1
		WHERE ai_platform_budget.held_micros+ai_platform_budget.spent_micros<=EXCLUDED.limit_micros
		AND ai_platform_budget.held_tokens+ai_platform_budget.spent_tokens<=EXCLUDED.limit_tokens
		RETURNING 1`, period, limit.LimitMicros, limit.LimitTokens).Scan(&updated)
	if err != nil {
		return errors.New("platform cap is below held or spent usage, or bootstrap failed")
	}
	return nil
}

func ensureTenantBudget(ctx context.Context, tx pgx.Tx, period, tenantID, scope string, limit BudgetLimit) error {
	var updated int
	err := tx.QueryRow(ctx, `INSERT INTO ai_budget_accounts(tenant_id,scope,period,limit_micros,limit_tokens)
		VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,scope,period) DO UPDATE SET
		limit_micros=EXCLUDED.limit_micros,limit_tokens=EXCLUDED.limit_tokens,
		version=ai_budget_accounts.version+1
		WHERE ai_budget_accounts.held_micros+ai_budget_accounts.spent_micros<=EXCLUDED.limit_micros
		AND ai_budget_accounts.held_tokens+ai_budget_accounts.spent_tokens<=EXCLUDED.limit_tokens
		RETURNING 1`, tenantID, scope, period, limit.LimitMicros, limit.LimitTokens).Scan(&updated)
	if err != nil {
		return errors.New("tenant or user cap is below held or spent usage, or bootstrap failed")
	}
	return nil
}
