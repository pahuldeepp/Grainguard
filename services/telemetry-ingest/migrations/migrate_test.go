package migrations

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
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
	var policies, tables int
	if err := conn.QueryRow(context.Background(),
		`SELECT (SELECT count(*) FROM pg_policies WHERE policyname = 'tenant_isolation'),
		        (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relforcerowsecurity)`).Scan(&policies, &tables); err != nil {
		t.Fatal(err)
	}
	if policies != 7 || tables != 7 {
		t.Fatalf("policies %d, forced-RLS tables %d", policies, tables)
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
