package main

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
)

// scopeValues are the session scopes the removed app.scope policies used to honour.
var scopeValues = []string{"dispatch-scan", "redrive-scan", "dead-scan", "quarantine"}

// noTenantCount counts rows of table for tenant with no tenant context, after setting
// app.scope to scope. RLS must return zero whatever the runtime role writes into the GUC.
func noTenantCount(t *testing.T, db TxStarter, scope, table, tenant string) int {
	t.Helper()
	tx, err := db.BeginTx(context.Background(), pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	ctx := context.Background()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.scope', $1, true)", scope); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := tx.QueryRow(ctx, fmt.Sprintf("SELECT count(*) FROM %s WHERE tenant_id = $1", table), tenant).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// deadIntentFor gives tenant dead intents with unpublished dead-letter rows plus one
// pending alert whose dispatch outbox rows are still due.
func deadIntentFor(t *testing.T, db TxStarter, tenant string) string {
	t.Helper()
	_, ids := deadIntents(t, db, tenant, &brokerDown{dlqDown: true})
	if _, err := RecordEvent(context.Background(), db, alertEvent(t, tenant), SourceRef{}); err != nil {
		t.Fatal(err)
	}
	return ids[0]
}

func TestScopeGUCCannotWidenCrossTenantReads(t *testing.T) {
	db := dbPool(t)
	a := randomUUID()
	id := deadIntentFor(t, db, a)
	if id == "" {
		t.Fatal("no dead intent created")
	}
	for _, table := range []string{"notification_intents", "dispatch_outbox", "dead_letter_outbox"} {
		if countRows(t, db, a, "SELECT count(*) FROM "+table) == 0 {
			t.Fatalf("fixture wrote no %s rows", table)
		}
		for _, scope := range scopeValues {
			if n := noTenantCount(t, db, scope, table, a); n != 0 {
				t.Errorf("app.scope=%s exposed %d %s rows without a tenant", scope, n, table)
			}
		}
	}
}

func TestNoPolicyReadsTheScopeGUC(t *testing.T) {
	db := dbPool(t)
	var names []string
	err := WithTenant(context.Background(), db, randomUUID(), func(ctx context.Context, tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT tablename || '.' || policyname FROM pg_policies
			WHERE schemaname = 'public' AND coalesce(qual, '') LIKE '%app.scope%'`)
		if err != nil {
			return err
		}
		names, err = pgx.CollectRows(rows, pgx.RowTo[string])
		return err
	})
	if err != nil || len(names) != 0 {
		t.Fatalf("session-scope policies remain: %v %v", names, err)
	}
}

// selectorColumns returns the result column names of a selector call.
func selectorColumns(t *testing.T, db TxStarter, sql string, args ...any) ([]string, int) {
	t.Helper()
	var cols []string
	n := 0
	err := inTx(context.Background(), db, "", "", func(ctx context.Context, tx pgx.Tx) error {
		rows, err := tx.Query(ctx, sql, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for _, f := range rows.FieldDescriptions() {
			cols = append(cols, f.Name)
		}
		for rows.Next() {
			n++
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	return cols, n
}

func TestSelectorsReturnIdentifiersOnly(t *testing.T) {
	db := dbPool(t)
	deadIntentFor(t, db, randomUUID())
	cases := map[string]string{
		"SELECT * FROM jobs_due_dispatch_refs($1)": "tenant_id,intent_id,available_at",
		"SELECT * FROM jobs_dead_intent_refs($1)":  "tenant_id,intent_id",
		"SELECT * FROM jobs_dead_letter_refs($1)":  "tenant_id,intent_id,delivery_generation",
	}
	for sql, want := range cases {
		cols, _ := selectorColumns(t, db, sql, 10)
		if got := fmt.Sprint(cols); got != fmt.Sprint(splitCols(want)) {
			t.Errorf("%s returned columns %s, want %s", sql, got, want)
		}
	}
	if _, n := selectorColumns(t, db, "SELECT * FROM jobs_dead_intent_refs($1)", 1_000_000); n > selectorMax {
		t.Errorf("selector returned %d rows, above the %d clamp", n, selectorMax)
	}
}

// Accept the migration's original pinned public schema and the equivalent
// hardened form with pg_temp explicitly last. Additional schemas or pg_temp
// first remain rejected; ACL and SECURITY DEFINER requirements are unchanged.
func TestSelectorsAreNotExecutableByPublic(t *testing.T) {
	db := dbPool(t)
	var open []string
	err := inTx(context.Background(), db, "", "", func(ctx context.Context, tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT p.proname || ':' || (p.proacl IS NOT NULL AND p.prosecdef
			  AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
			  AND has_function_privilege('jobs_app', p.oid, 'EXECUTE')
			  AND coalesce(p.proconfig, '{}') && ARRAY['search_path=public', 'search_path=public, pg_temp']::text[])::text
			FROM pg_proc p WHERE p.proname LIKE 'jobs\_%\_refs' ORDER BY 1`)
		if err != nil {
			return err
		}
		open, err = pgx.CollectRows(rows, pgx.RowTo[string])
		return err
	})
	want := "[jobs_dead_intent_refs:true jobs_dead_letter_refs:true jobs_due_dispatch_refs:true]"
	if err != nil || fmt.Sprint(open) != want {
		t.Fatalf("selectors missing, open to PUBLIC or not pinned SECURITY DEFINER: %v %v", open, err)
	}
}

func splitCols(s string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return out
}
