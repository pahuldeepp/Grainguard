package migrations

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

var versionName = regexp.MustCompile(`^read_v[1-9][0-9]{0,8}$`)

// ProvisionVersion creates a fresh shadow in greenguard_read. A failed DDL step
// rolls back the entire schema. Existing shadows are never reset or overwritten.
func ProvisionVersion(ctx context.Context, migrationURL, schema string) error {
	cfg, err := provisionConfig(migrationURL, schema)
	if err != nil {
		return err
	}
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if err := createVersionSchema(ctx, tx, schema); err != nil {
		return err
	}
	if err := applyVersionFiles(ctx, tx, schema); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func provisionConfig(migrationURL, schema string) (*pgx.ConnConfig, error) {
	if !versionName.MatchString(schema) {
		return nil, errors.New("invalid read version schema")
	}
	cfg, err := pgx.ParseConfig(migrationURL)
	if err != nil {
		return nil, errors.New("invalid migration URL")
	}
	if (cfg.Database != "greenguard_read" && !strings.HasPrefix(cfg.Database, "greenguard_read_replay_test_")) || cfg.User != "projection_migrator" {
		return nil, errors.New("version provisioning requires projection_migrator in greenguard_read")
	}
	cfg.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	return cfg, nil
}

// createVersionSchema serializes provisioning and refuses an existing schema.
func createVersionSchema(ctx context.Context, tx pgx.Tx, schema string) error {
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7240513)"); err != nil {
		return err
	}
	var exists bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)", schema).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("projection schema %s already exists", schema)
	}
	for _, statement := range []string{"CREATE SCHEMA " + schema, "REVOKE ALL ON SCHEMA " + schema + " FROM PUBLIC", "GRANT USAGE ON SCHEMA " + schema + " TO projection_app"} {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, "SELECT set_config('search_path',$1,true)", schema+",pg_catalog")
	return err
}

func applyVersionFiles(ctx context.Context, tx pgx.Tx, schema string) error {
	for _, file := range []string{"000001_projection.up.sql", "000002_history_retention.up.sql", "000003_replay_manifest.up.sql", "000005_global_replay.up.sql", "000016_domain_product.up.sql", "000023_history_maintenance_runtime.up.sql"} {
		body, readErr := files.ReadFile(file)
		if readErr != nil {
			return readErr
		}
		if _, err := tx.Exec(ctx, versionSQL(string(body), schema)); err != nil {
			return fmt.Errorf("provision %s: %w", file, err)
		}
	}
	_, err := tx.Exec(ctx, "SELECT greenguard_internal.provision_projection_watermarks($1)", schema)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "UPDATE greenguard_internal.tenant_ownership SET updated_at=updated_at WHERE state='active'")
	return err
}

func versionSQL(sql, schema string) string {
	// 000002's transaction delimiters belong to the outer provisioning transaction.
	sql = strings.ReplaceAll(sql, "BEGIN;\n", "")
	sql = strings.ReplaceAll(sql, "\nCOMMIT;", "")
	sql = strings.ReplaceAll(sql, "public.", schema+".")
	sql = strings.ReplaceAll(sql, "pg_catalog,public", "pg_catalog,"+schema)
	return sql
}
