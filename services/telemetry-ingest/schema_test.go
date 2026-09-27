package main

import (
	"context"
	"errors"
	"sort"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var tenantTables = []string{"audit_events", "consumer_inbox", "device_bindings", "device_streams", "ingest_receipts", "ingest_rejection_samples", "outbox_events", "readings", "saga_binding_requests"}

// Every forced-RLS table in the schema. entitlement_feed_health has no tenant column
// (ADR-0022), so it is deliberately absent from tenantTables.
var catalogTables = []string{"audit_events", "consumer_inbox", "device_bindings", "device_streams", "entitlement_feed_health", "ingest_quota_usage", "ingest_receipts", "ingest_rejection_samples", "outbox_events", "readings", "saga_binding_requests", "tenant_entitlements"}

func sqlState(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

func TestD02RuntimeRoleCannotBypassRLSAndOwnsNothing(t *testing.T) {
	admin := adminConn(t, "greenguard_telemetry")
	var super, bypass bool
	if err := admin.QueryRow(context.Background(),
		"SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'telemetry_app'").Scan(&super, &bypass); err != nil {
		t.Fatal(err)
	}
	if super || bypass {
		t.Fatalf("telemetry_app must not be superuser or bypass RLS: %v %v", super, bypass)
	}
	rows, err := admin.Query(context.Background(),
		`SELECT relname, pg_get_userbyid(relowner), relrowsecurity AND relforcerowsecurity
		   FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname NOT IN ('schema_migrations', 'binding_feed_checkpoints')`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name, owner string
		var forced bool
		if err := rows.Scan(&name, &owner, &forced); err != nil {
			t.Fatal(err)
		}
		if owner != "telemetry_migrator" || !forced {
			t.Errorf("%s: owner %s, forced RLS %v", name, owner, forced)
		}
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) != len(catalogTables) {
		t.Fatalf("tables: %v", names)
	}
	for i := range names {
		if names[i] != catalogTables[i] {
			t.Fatalf("tables: %v", names)
		}
	}
}

func TestD02WithoutTenantContextNoRowsAreVisible(t *testing.T) {
	db := direct(t, 1)
	mustApply(t, db, eventSpec{kind: "device.registered", tenant: randomUUID(), device: randomUUID(), version: 1}, BindingApplied)
	for _, table := range tenantTables {
		var n int
		if err := db.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&n); err != nil && sqlState(err) != "42501" {
			t.Fatal(err)
		} else if err == nil && n != 0 {
			t.Fatalf("%s leaks %d rows without a tenant", table, n)
		}
	}
}

func TestD02OneTenantCannotReadOrWriteAnother(t *testing.T) {
	db := pooled(t, 4)
	a, b := randomUUID(), randomUUID()
	deviceA := randomUUID()
	mustApply(t, db, eventSpec{kind: "device.registered", tenant: a, device: deviceA, version: 1}, BindingApplied)
	mustApply(t, db, eventSpec{kind: "device.registered", tenant: b, device: randomUUID(), version: 1}, BindingApplied)

	err := WithTenant(context.Background(), db, b, func(ctx context.Context, tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM device_bindings WHERE device_id = $1", deviceA).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			t.Errorf("tenant B reads tenant A's binding")
		}
		tag, err := tx.Exec(ctx, "UPDATE device_bindings SET status = 'deleted' WHERE device_id = $1", deviceA)
		if err != nil || tag.RowsAffected() != 0 {
			t.Errorf("tenant B changed tenant A's binding: %v %v", tag, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = WithTenant(context.Background(), db, b, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			"INSERT INTO device_bindings (tenant_id, device_id, site_id, inventory_version, status) VALUES ($1, $2, $3, 1, 'active')",
			a, randomUUID(), randomUUID())
		return err
	})
	if sqlState(errors.Unwrap(errors.Unwrap(err))) != "42501" && sqlState(unwrapAll(err)) != "42501" {
		t.Fatalf("forged tenant insert must fail with 42501: %v", err)
	}
}

func unwrapAll(err error) error {
	for {
		next := errors.Unwrap(err)
		if next == nil {
			return err
		}
		if sqlState(next) != "" {
			return next
		}
		err = next
	}
}

func TestRuntimeRoleCannotDeleteRewriteIdentityOrReadHistory(t *testing.T) {
	db := pooled(t, 2)
	tenant, device := randomUUID(), randomUUID()
	mustApply(t, db, eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1}, BindingApplied)
	for name, sql := range map[string]string{
		"delete binding":     "DELETE FROM device_bindings",
		"rewrite tenant":     "UPDATE device_bindings SET tenant_id = gen_random_uuid()",
		"rewrite device":     "UPDATE device_bindings SET device_id = gen_random_uuid()",
		"rewrite inbox":      "UPDATE consumer_inbox SET event = '{}'",
		"delete inbox":       "DELETE FROM consumer_inbox",
		"read outbox":        "SELECT * FROM outbox_events",
		"read audit":         "SELECT * FROM audit_events",
		"update outbox":      "UPDATE outbox_events SET payload = '{}'",
		"rewrite stream key": "UPDATE device_streams SET device_id = gen_random_uuid()",
	} {
		err := WithTenant(context.Background(), db, tenant, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, sql)
			return err
		})
		if sqlState(unwrapAll(err)) != "42501" {
			t.Errorf("%s: want 42501, got %v", name, err)
		}
	}
}

type sessionDB interface {
	TxStarter
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// scopedRead runs one tenant transaction, checks every visible row belongs to the tenant,
// and returns the Postgres backend that served it.
func scopedRead(t *testing.T, label string, db sessionDB, tenant string) int {
	t.Helper()
	var pid int
	err := WithTenant(context.Background(), db, tenant, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, "SELECT tenant_id::text FROM device_bindings")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var seen string
			if err := rows.Scan(&seen); err != nil {
				return err
			}
			if seen != tenant {
				t.Errorf("%s: tenant %s saw %s", label, tenant, seen)
			}
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	return pid
}

func assertNoTenantContext(t *testing.T, label string, db sessionDB) {
	t.Helper()
	var leaked *string
	if err := db.QueryRow(context.Background(), "SELECT NULLIF(current_setting('app.tenant_id', true), '')").Scan(&leaked); err != nil || leaked != nil {
		t.Fatalf("%s: context leaked after transaction: %v %v", label, leaked, err)
	}
}

func TestD03TenantContextNeverOutlivesItsTransaction(t *testing.T) {
	cases := map[string]sessionDB{
		"direct session": direct(t, 1),
		"PgBouncer":      pooled(t, 1),
	}
	for label, db := range cases {
		a, b := randomUUID(), randomUUID()
		mustApply(t, db, eventSpec{kind: "device.registered", tenant: a, device: randomUUID(), version: 1}, BindingApplied)
		mustApply(t, db, eventSpec{kind: "device.registered", tenant: b, device: randomUUID(), version: 1}, BindingApplied)
		pids := map[int]bool{}
		for _, tenant := range []string{a, b, a, b, a, b, a, b} {
			pids[scopedRead(t, label, db, tenant)] = true
			assertNoTenantContext(t, label, db)
		}
		if label == "direct session" && len(pids) != 1 {
			t.Fatalf("direct session must reuse one backend, saw %d", len(pids))
		}
	}
}
