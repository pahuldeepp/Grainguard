package main

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

// PostgreSQL expands SELECT * into a column list when deparsing a view.
var routeDefinition = regexp.MustCompile(`(?is)^\s*SELECT\s+[a-z_0-9.,\s"*]+\s+FROM\s+"?([a-z_][a-z_0-9]*)"?\."?([a-z_][a-z_0-9]*)"?\s*;?\s*$`)
var latestInboxRoute = regexp.MustCompile(`(?is)\bJOIN\s+"?([a-z_][a-z_0-9]*)"?\."?consumer_inbox"?`)

// activeReadSchema rejects mixed or unexpected read routes. It must run in the
// same transaction that holds the promotion lock, before replacing any view.
func activeReadSchema(ctx context.Context, tx pgx.Tx) (string, error) {
	if _, err := tx.Exec(ctx, `SELECT set_config('search_path','pg_catalog',true)`); err != nil {
		return "", err
	}
	var active string
	for _, name := range promotionViews {
		schema, err := readViewSchema(ctx, tx, name)
		if err != nil {
			return "", err
		}
		if active != "" && schema != active {
			return "", errors.New("read views route to different projection versions")
		}
		active = schema
	}
	if err := checkLatestReadingsRoute(ctx, tx, active); err != nil {
		return "", err
	}
	return active, nil
}

// readViewSchema returns the projection schema that read.<name> selects from.
func readViewSchema(ctx context.Context, tx pgx.Tx, name string) (string, error) {
	var definition string
	if err := tx.QueryRow(ctx, `SELECT pg_get_viewdef(to_regclass($1), true)`, "read."+name).Scan(&definition); err != nil {
		return "", err
	}
	match := routeDefinition.FindStringSubmatch(definition)
	if len(match) != 3 || match[2] != name {
		return "", fmt.Errorf("read.%s has an unsupported definition: %q", name, definition)
	}
	if match[1] != "public" && !promotionIdentifier.MatchString(match[1]) {
		return "", fmt.Errorf("read.%s routes to an invalid schema", name)
	}
	return match[1], nil
}

func checkLatestReadingsRoute(ctx context.Context, tx pgx.Tx, active string) error {
	var latest string
	if err := tx.QueryRow(ctx, `SELECT pg_get_viewdef(to_regclass('read.latest_readings'), true)`).Scan(&latest); err != nil {
		return err
	}
	match := latestInboxRoute.FindStringSubmatch(latest)
	if len(match) != 2 || match[1] != active || !strings.Contains(latest, "read.device_latest") || !strings.Contains(latest, "read.reading_history") {
		return errors.New("read.latest_readings does not route through the active projection")
	}
	return nil
}

// projectionTenants requires a role that can bypass forced RLS. Setting
// row_security=off makes a filtered result an error rather than false proof.
func projectionTenants(ctx context.Context, tx pgx.Tx, schema string) ([]string, error) {
	if schema != "public" && !promotionIdentifier.MatchString(schema) {
		return nil, ErrInvalidProjectionSchema
	}
	if _, err := tx.Exec(ctx, `SET LOCAL row_security = off`); err != nil {
		return nil, err
	}
	tables := []string{"consumer_inbox", "device_views", "reading_history", "device_latest", "projection_streams", "stream_gaps", "projection_notifications"}
	parts := make([]string, 0, len(tables))
	for _, table := range tables {
		parts = append(parts, fmt.Sprintf("SELECT tenant_id FROM %s.%s", schema, table))
	}
	rows, err := tx.Query(ctx, "SELECT DISTINCT tenant_id::text FROM ("+strings.Join(parts, " UNION ALL ")+") AS tenants ORDER BY 1")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tenants []string
	for rows.Next() {
		var tenant string
		if err := rows.Scan(&tenant); err != nil {
			return nil, err
		}
		if tenant != infrastructureTenant {
			tenants = append(tenants, tenant)
		}
	}
	return tenants, rows.Err()
}

func compareTenantCensus(canonical map[string]referenceState, live, shadow []string) error {
	if err := canonicalTenantSet(canonical, append([]string(nil), live...)); err != nil {
		return fmt.Errorf("live tenant census: %w", err)
	}
	if err := canonicalTenantSet(canonical, append([]string(nil), shadow...)); err != nil {
		return fmt.Errorf("shadow tenant census: %w", err)
	}
	return nil
}
