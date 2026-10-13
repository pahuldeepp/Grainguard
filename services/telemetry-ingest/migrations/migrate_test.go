package migrations

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/golang-migrate/migrate/v4/source"
	"github.com/jackc/pgx/v5"
)

func env(t *testing.T, key string) string {
	t.Helper()
	v := os.Getenv(key)
	if v == "" {
		t.Skipf("%s is not set; run through make so the local database is available", key)
	}
	return v
}

func withDatabase(t *testing.T, rawURL, database string) string {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + database
	return u.String()
}

func TestUpBuildsAnEmptyDatabaseAndIsRepeatable(t *testing.T) {
	admin, err := pgx.Connect(context.Background(), withDatabase(t, env(t, "POSTGRES_ADMIN_URL"), "postgres"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	scratch := fmt.Sprintf("greenguard_telemetry_d01_%x", b)
	if _, err := admin.Exec(context.Background(), "CREATE DATABASE "+scratch+" OWNER telemetry_migrator"); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(context.Background(), "DROP DATABASE "+scratch+" WITH (FORCE)")

	target := withDatabase(t, env(t, "TELEMETRY_MIGRATION_URL"), scratch)
	for i := 0; i < 2; i++ {
		if err := Up(target); err != nil {
			t.Fatalf("run %d: %v", i+1, err)
		}
	}
	conn, err := pgx.Connect(context.Background(), withDatabase(t, env(t, "POSTGRES_ADMIN_URL"), scratch))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var policies, tables, cdcPolicies int
	if err := conn.QueryRow(context.Background(),
		`SELECT (SELECT count(*) FROM pg_policies WHERE policyname = 'tenant_isolation'),
		        (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relforcerowsecurity),
		        (SELECT count(*) FROM pg_policies WHERE policyname = 'cdc_outbox_snapshot')`).Scan(&policies, &tables, &cdcPolicies); err != nil {
		t.Fatal(err)
	}
	if policies != 12 || tables != 13 || cdcPolicies != 1 {
		t.Fatalf("tenant policies %d, forced-RLS tables %d, CDC policies %d", policies, tables, cdcPolicies)
	}
}

func TestAuditReaderIsSelectOnlyAndPlacementAdmissionScoped(t *testing.T) {
	admin, err := pgx.Connect(context.Background(), withDatabase(t, env(t, "POSTGRES_ADMIN_URL"), "greenguard_telemetry"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	var selectAudit, insertAudit, selectDevices, executeAdmission, publicExecuteAdmission, forcedRLS, safeRole bool
	var memberships int
	if err := admin.QueryRow(context.Background(), `SELECT
		has_table_privilege('inventory_audit_reader','public.audit_events','SELECT'),
		has_table_privilege('inventory_audit_reader','public.audit_events','INSERT'),
		has_table_privilege('inventory_audit_reader','public.device_bindings','SELECT'),
		has_function_privilege('inventory_audit_reader','greenguard_internal.admit_tenant_placement(uuid,text,uuid,bigint)','EXECUTE'),
		has_function_privilege('public','greenguard_internal.admit_tenant_placement(uuid,text,uuid,bigint)','EXECUTE'),
		(SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.audit_events'::regclass),
		(SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolbypassrls FROM pg_roles WHERE rolname='inventory_audit_reader'),
		(SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid WHERE r.rolname='inventory_audit_reader' OR g.rolname='inventory_audit_reader')`).
		Scan(&selectAudit, &insertAudit, &selectDevices, &executeAdmission, &publicExecuteAdmission, &forcedRLS, &safeRole, &memberships); err != nil {
		t.Fatal(err)
	}
	if !selectAudit || insertAudit || selectDevices || !executeAdmission || publicExecuteAdmission || !forcedRLS || !safeRole || memberships != 0 {
		t.Fatalf("audit reader privileges are too broad or not admitted: audit SELECT=%t INSERT=%t devices SELECT=%t admission=%t public admission=%t forced RLS=%t safe role=%t memberships=%d", selectAudit, insertAudit, selectDevices, executeAdmission, publicExecuteAdmission, forcedRLS, safeRole, memberships)
	}
}

func TestUpReportsConnectionFailuresWithoutCredentials(t *testing.T) {
	for _, target := range []string{"postgresql://nobody:secret@127.0.0.1:1/none", "not a url"} {
		err := Up(target)
		if err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "nobody") {
			t.Fatalf("connect failure must not echo credentials: %v", err)
		}
	}
	// The runtime role cannot create the version table, which fails while connecting.
	if err := Up(env(t, "TELEMETRY_DIRECT_URL")); err == nil {
		t.Fatal("the runtime role must not be able to migrate")
	}
}

func TestUpReportsAFailingMigration(t *testing.T) {
	admin, err := pgx.Connect(context.Background(), withDatabase(t, env(t, "POSTGRES_ADMIN_URL"), "postgres"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	scratch := fmt.Sprintf("greenguard_telemetry_bad_%x", b)
	if _, err := admin.Exec(context.Background(), "CREATE DATABASE "+scratch+" OWNER telemetry_migrator"); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(context.Background(), "DROP DATABASE "+scratch+" WITH (FORCE)")
	conn, err := pgx.Connect(context.Background(), withDatabase(t, env(t, "TELEMETRY_MIGRATION_URL"), scratch))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(context.Background(), "CREATE TABLE device_bindings (x int)"); err != nil {
		t.Fatal(err)
	}
	if err := Up(withDatabase(t, env(t, "TELEMETRY_MIGRATION_URL"), scratch)); err == nil || !strings.Contains(err.Error(), "apply migrations") {
		t.Fatalf("got %v", err)
	}
}

func TestUpReportsUnreadableMigrationSource(t *testing.T) {
	original := newSource
	newSource = func() (source.Driver, error) { return nil, errors.New("boom") }
	defer func() { newSource = original }()
	if err := Up("postgresql://x"); err == nil || !strings.Contains(err.Error(), "open migrations") {
		t.Fatalf("got %v", err)
	}
}

func TestDriverURLAcceptsBothPostgresSchemes(t *testing.T) {
	cases := map[string]string{
		"postgresql://u:p@h:5432/db?x=1": "pgx5://u:p@h:5432/db?x=1",
		"postgres://u:p@h:5432/db":       "pgx5://u:p@h:5432/db",
		"pgx5://u:p@h/db":                "pgx5://u:p@h/db",
		"mysql://u@h/db":                 "mysql://u@h/db",
		"":                               "",
	}
	for in, want := range cases {
		if got := driverURL(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestTelemetryV2UpgradePreservesLegacyRowsAndRefusesLossyRollback(t *testing.T) {
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, withDatabase(t, env(t, "POSTGRES_ADMIN_URL"), "postgres"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	scratch := fmt.Sprintf("greenguard_telemetry_v2_%x", b)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+scratch+" OWNER telemetry_migrator"); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP DATABASE "+scratch+" WITH (FORCE)")
	conn, err := pgx.Connect(ctx, withDatabase(t, env(t, "POSTGRES_ADMIN_URL"), scratch))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	source, err := newSource()
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	for version := uint(1); version <= 11; version++ {
		file, _, err := source.ReadUp(version)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(file)
		_ = file.Close()
		if err != nil {
			t.Fatal(err)
		}
		// Run as the owner while setting up; admin retains a seam to prove RLS-hidden
		// rows cannot evade the DDL rollback guard.
		if _, err := conn.Exec(ctx, "SET ROLE telemetry_migrator"); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(ctx, string(data)); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(ctx, "RESET ROLE"); err != nil {
			t.Fatal(err)
		}
	}
	tenant := "11111111-1111-4111-8111-111111111111"
	device := "33333333-3333-4333-8333-333333333333"
	reading := "bb70cd06-0720-461a-8ecf-a56754985f87"
	if _, err := conn.Exec(ctx, `INSERT INTO device_bindings(tenant_id,device_id,site_id,inventory_version,status) VALUES($1,$2,$1,1,'active')`, tenant, device); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO readings(tenant_id,reading_id,device_id,stream_version,source_message_id,site_id,binding_version,observed_at,received_at,temperature_c) VALUES($1,$2,$3,1,'legacy',$1,1,now(),now(),0)`, tenant, reading, device); err != nil {
		t.Fatal(err)
	}
	data, err := files.ReadFile("000012_additive_telemetry.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, "SET ROLE telemetry_migrator"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, string(data)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, "RESET ROLE"); err != nil {
		t.Fatal(err)
	}
	var preserved bool
	if err := conn.QueryRow(ctx, `SELECT temperature_c=0 AND relative_humidity_percent IS NULL AND co2_ppm IS NULL AND grain_moisture_percent IS NULL AND schema_version=1 AND sensor_observations='[]'::jsonb FROM readings WHERE tenant_id=$1 AND reading_id=$2`, tenant, reading).Scan(&preserved); err != nil || !preserved {
		t.Fatalf("legacy upgrade preserved=%v err=%v", preserved, err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO readings(tenant_id,reading_id,device_id,stream_version,source_message_id,site_id,binding_version,observed_at,received_at,co2_ppm,schema_version,measurement_units) VALUES($1,'cc70cd06-0720-461a-8ecf-a56754985f87',$2,2,'v2',$1,1,now(),now(),450,2,'{"co2_ppm":"ppm"}')`, tenant, device); err != nil {
		t.Fatal(err)
	}
	owner, err := pgx.Connect(ctx, withDatabase(t, env(t, "TELEMETRY_MIGRATION_URL"), scratch))
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close(ctx)
	rollback, err := files.ReadFile("000012_additive_telemetry.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, string(rollback)); err == nil {
		t.Fatal("rollback removed immutable v2 rows despite forced RLS")
	}
}
