package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func envOrSkip(t *testing.T, key string) string {
	t.Helper()
	value := os.Getenv(key)
	if value == "" {
		t.Skipf("%s is not set; run through make so the local database is available", key)
	}
	return value
}

func openPool(t *testing.T, key string, maxConns int32) *pgxpool.Pool {
	t.Helper()
	config, err := pgxpool.ParseConfig(envOrSkip(t, key))
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = maxConns
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	configureFixturePlacement(t, config)
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// pooled uses PgBouncer (transaction pooling); direct keeps one real session.
func pooled(t *testing.T, maxConns int32) *pgxpool.Pool {
	return openPool(t, "TELEMETRY_DATABASE_URL", maxConns)
}
func direct(t *testing.T, maxConns int32) *pgxpool.Pool {
	return openPool(t, "TELEMETRY_DIRECT_URL", maxConns)
}

// adminConn is a superuser session, which bypasses RLS so tests can see what was written.
func adminConn(t *testing.T, database string) *pgx.Conn {
	t.Helper()
	u, err := url.Parse(envOrSkip(t, "POSTGRES_ADMIN_URL"))
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + database
	config, err := pgx.ParseConfig(u.String())
	if err != nil {
		t.Fatal(err)
	}
	config.Tracer = fixturePlacementTracer{t, u.String()}
	conn, err := pgx.ConnectConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

func adminInt(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := adminConn(t, "greenguard_telemetry").QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func randomUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

type eventSpec struct {
	kind, tenant, device string
	version              int
	site                 string
	bin                  any
	status               string
	id                   string
}

// withIDs fixes the random parts so the same spec always serialises to the same event.
func (e eventSpec) withIDs() eventSpec {
	if e.id == "" {
		e.id = randomUUID()
	}
	if e.site == "" {
		e.site = randomUUID()
	}
	if e.status == "" {
		e.status = "active"
	}
	return e
}

func (e eventSpec) json() []byte {
	e = e.withIDs()
	v := fmt.Sprint(e.version)
	payload := map[string]any{"device_id": e.device, "binding_version": v}
	switch e.kind {
	case "device.registered":
		payload["serial_number"] = "SN-1"
		payload["site_id"], payload["bin_id"], payload["status"] = e.site, e.bin, e.status
	case "device.binding_changed":
		payload["site_id"], payload["bin_id"] = e.site, e.bin
	case "device.status_changed":
		payload["status"] = e.status
	}
	data, _ := json.Marshal(map[string]any{
		"event_id": e.id, "event_type": e.kind, "schema_version": 1, "tenant_id": e.tenant,
		"aggregate_type": "device", "aggregate_id": e.device, "aggregate_version": v, "payload": payload,
	})
	return data
}

// Fixture administrator mutations carry the same tenant and shard identity as runtime writes.
func fixtureAdminExec(t *testing.T, conn *pgx.Conn, tenant, query string, args ...any) (pgconn.CommandTag, error) {
	t.Helper()
	ctx := context.Background()
	tx, err := conn.Begin(ctx)
	if err != nil {
		return pgconn.CommandTag{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenant); err != nil {
		return pgconn.CommandTag{}, err
	}
	tag, err := tx.Exec(ctx, query, args...)
	if err != nil {
		return tag, err
	}
	return tag, tx.Commit(ctx)
}
