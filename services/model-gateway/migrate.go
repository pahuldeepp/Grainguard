package modelgateway

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

//go:embed migrations/00*.sql
var migrationFiles embed.FS

var rdsHostPattern = regexp.MustCompile(`^[A-Za-z0-9.-]+\.rds\.amazonaws\.com$`)

// ValidateMigrationDSN rejects any database target except the exact disposable
// Model Gateway owner on the declared RDS endpoint with full certificate check.
func ValidateMigrationDSN(dsn, expectedHost string) error {
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.User == nil {
		return errors.New("Model Gateway migration DSN is invalid")
	}
	password, hasPassword := u.User.Password()
	if !hasPassword || password == "" || u.User.Username() != "model_gateway_migrator" ||
		u.Hostname() != expectedHost || u.Port() != "5432" || u.Path != "/greenguard_ai_usage" ||
		u.Fragment != "" || !rdsHostPattern.MatchString(expectedHost) {
		return errors.New("Model Gateway migration DSN does not match the disposable RDS owner contract")
	}
	query := u.Query()
	for key := range query {
		if key != "sslmode" && key != "sslrootcert" && key != "connect_timeout" {
			return errors.New("Model Gateway migration DSN contains an unsupported parameter")
		}
	}
	if values := query["sslmode"]; len(values) != 1 || values[0] != "verify-full" {
		return errors.New("Model Gateway migration DSN must use verify-full TLS")
	}
	if values := query["sslrootcert"]; len(values) != 1 || values[0] != "/rds-ca/ca.pem" {
		return errors.New("Model Gateway migration DSN must use the projected RDS CA")
	}
	if values := query["connect_timeout"]; len(values) > 0 {
		if len(values) != 1 {
			return errors.New("Model Gateway migration connection timeout is invalid")
		}
		n, parseErr := strconv.Atoi(values[0])
		if parseErr != nil || n < 1 || n > 10 {
			return errors.New("Model Gateway migration connection timeout is invalid")
		}
	}
	return nil
}

// ApplyEmbeddedMigrations uses a transactional ledger and a per-database
// advisory lock; migration SQL never comes from a mutable network location.
func ApplyEmbeddedMigrations(ctx context.Context, dsn string) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return errors.New("cannot connect to the configured migration database")
	}
	defer conn.Close(context.Background())
	var database, role string
	if err := conn.QueryRow(ctx, "SELECT current_database(),current_user").Scan(&database, &role); err != nil || database != "greenguard_ai_usage" || role != "model_gateway_migrator" {
		return errors.New("migration connection identity mismatch")
	}
	var unsafe bool
	if err := conn.QueryRow(ctx, "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user").Scan(&unsafe); err != nil || unsafe {
		return errors.New("Model Gateway migration role must not be superuser or bypass RLS")
	}
	for _, runtimeRole := range []string{"model_gateway_app", "model_gateway_usage_app"} {
		if err := conn.QueryRow(ctx, "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=$1", runtimeRole).Scan(&unsafe); err != nil || unsafe {
			return fmt.Errorf("runtime role %s must not be superuser or bypass RLS", runtimeRole)
		}
	}
	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS model_gateway_schema_migrations (
		version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`); err != nil {
		return errors.New("cannot create migration ledger")
	}
	entries, err := fs.Glob(migrationFiles, "migrations/00*.sql")
	if err != nil || len(entries) != 2 {
		return errors.New("embedded Model Gateway migration inventory is incomplete")
	}
	sort.Strings(entries)
	for _, name := range entries {
		sql, readErr := migrationFiles.ReadFile(name)
		if readErr != nil {
			return errors.New("cannot read embedded Model Gateway migration")
		}
		version := strings.TrimSuffix(strings.TrimPrefix(name, "migrations/"), ".sql")
		tx, beginErr := conn.Begin(ctx)
		if beginErr != nil {
			return errors.New("cannot start Model Gateway migration transaction")
		}
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext('greenguard.model-gateway.migrations'))"); err == nil {
			var exists bool
			err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM model_gateway_schema_migrations WHERE version=$1)", version).Scan(&exists)
			if err == nil && !exists {
				_, err = tx.Exec(ctx, string(sql))
				if err == nil {
					_, err = tx.Exec(ctx, "INSERT INTO model_gateway_schema_migrations(version) VALUES($1)", version)
				}
			}
		}
		if err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("Model Gateway migration %s failed", version)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("Model Gateway migration %s could not commit", version)
		}
	}
	return nil
}
