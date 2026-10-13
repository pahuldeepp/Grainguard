package main

import (
	"context"
	"net"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"greenguard.local/saga-orchestrator/migrations"
)

// isolateLoopDatabase keeps the worker's real selector independent of work left
// by other live tests. Only this disposable database is created and dropped;
// migrations run as the production schema owner and the worker uses saga_app.
func isolateLoopDatabase(t *testing.T, cfg *pgxpool.Config) {
	t.Helper()
	adminConfig, migrationURL := loopDatabaseConfigs(t, cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	admin, err := pgx.ConnectConfig(ctx, adminConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	name := "saga_loop_" + strings.ReplaceAll(liveUUID(t), "-", "")
	quoted := pgx.Identifier{name}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quoted+" OWNER saga_migrator TEMPLATE template0"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dropLoopDatabase(t, adminConfig, quoted) })
	migrationURL.Path = "/" + name
	if err := migrations.Up(migrationURL.String()); err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.Database = name
}

func loopDatabaseConfigs(t *testing.T, cfg *pgxpool.Config) (*pgx.ConnConfig, *url.URL) {
	t.Helper()
	adminURL := os.Getenv("POSTGRES_ADMIN_URL")
	if adminURL == "" {
		t.Skip("POSTGRES_ADMIN_URL required for isolated worker fixture")
	}
	adminConfig, err := pgx.ParseConfig(adminURL)
	if err != nil {
		t.Fatal("invalid fixture admin configuration")
	}
	migrationURL, err := url.Parse(os.Getenv("SAGA_MIGRATION_URL"))
	if err != nil || (migrationURL.Scheme != "postgres" && migrationURL.Scheme != "postgresql") {
		t.Fatal("SAGA_MIGRATION_URL must be an explicit PostgreSQL fixture URL")
	}
	migrationConfig, err := pgx.ParseConfig(migrationURL.String())
	if err != nil {
		t.Fatal("invalid fixture migration configuration")
	}
	if !loopDatabaseHost(adminConfig.Host) || cfg.ConnConfig.Host != adminConfig.Host || migrationConfig.Host != adminConfig.Host ||
		cfg.ConnConfig.Port != adminConfig.Port || migrationConfig.Port != adminConfig.Port {
		t.Fatal("isolated worker fixture requires direct local admin, migration and runtime connections on the same host and port")
	}
	if cfg.ConnConfig.User != "saga_app" || migrationConfig.User != "saga_migrator" {
		t.Fatal("isolated worker fixture requires saga_app runtime and saga_migrator migration roles")
	}
	return adminConfig, migrationURL
}

func loopDatabaseHost(host string) bool {
	ip := net.ParseIP(host)
	return host == "localhost" || (ip != nil && ip.IsLoopback())
}

func dropLoopDatabase(t *testing.T, adminConfig *pgx.ConnConfig, quoted string) {
	t.Helper()
	cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(cleanup, adminConfig)
	if err != nil {
		t.Error(err)
		return
	}
	defer conn.Close(cleanup)
	if _, err := conn.Exec(cleanup, "DROP DATABASE "+quoted+" WITH (FORCE)"); err != nil {
		t.Error(err)
	}
}
