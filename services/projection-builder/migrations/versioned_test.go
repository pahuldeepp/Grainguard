package migrations

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestVersionSQLRebindsHistory(t *testing.T) {
	body, err := files.ReadFile("000002_history_retention.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	sql := versionSQL(string(body), "read_v7")
	for _, want := range []string{"read_v7.reading_history", "pg_catalog,read_v7", "read_v7.%I"} {
		if !strings.Contains(sql, want) {
			t.Fatalf("missing %s", want)
		}
	}
	if strings.Contains(sql, "public.") || strings.Contains(sql, "\nCOMMIT;") {
		t.Fatal("shadow DDL escapes provisioning transaction")
	}
}

func TestProvisionVersionRejectsUnsafeTarget(t *testing.T) {
	for _, schema := range []string{"public", "read_v0", "read_v1;DROP SCHEMA public", "read_v01"} {
		if err := ProvisionVersion(context.Background(), "", schema); err == nil {
			t.Fatal(schema)
		}
	}
	if err := ProvisionVersion(context.Background(), "postgres://projection_migrator@localhost/other", "read_v1"); err == nil {
		t.Fatal("accepted other database")
	}
}

func TestProvisionVersionDatabase(t *testing.T) {
	url := os.Getenv("PROJECTION_MIGRATION_URL")
	if url == "" {
		t.Skip("PROJECTION_MIGRATION_URL unavailable")
	}
	// The test creates a fresh disposable schema and removes only that schema.
	// Production provisioning remains forward-only.
	if os.Getenv("PROJECTION_VERSION_TEST") != "1" {
		t.Skip("set PROJECTION_VERSION_TEST=1 in disposable greenguard_read")
	}
	ctx := context.Background()
	schema := fmt.Sprintf("read_v%d", time.Now().UnixNano()%1000000000)
	if err := ProvisionVersion(ctx, url, schema); err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	t.Cleanup(func() { _, _ = conn.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE") })
	var total, forced int
	if err := conn.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE relnamespace=$1::regnamespace AND relkind IN ('r','p') AND NOT relispartition`, schema).Scan(&total, &forced); err != nil {
		t.Fatal(err)
	}
	if total != 10 || forced != total {
		t.Fatalf("shadow RLS %d/%d", forced, total)
	}
	if err := ProvisionVersion(ctx, url, schema); err == nil {
		t.Fatal("existing shadow overwritten")
	}
}
