package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
	"greenguard.local/projection-builder/migrations"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func randomUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func envOrSkip(t *testing.T, key string) string {
	t.Helper()
	v := os.Getenv(key)
	if v == "" {
		t.Skipf("%s is not set; local PostgreSQL test not run", key)
	}
	return v
}
func databaseURL(t *testing.T, raw, name string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	return u.String()
}
func dbPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(envOrSkip(t, "PROJECTION_DIRECT_URL"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	configureFixturePlacement(t, cfg)
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}
func TestDatabaseMigrations(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, envOrSkip(t, "POSTGRES_ADMIN_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	name := fmt.Sprintf("projection_test_%d", time.Now().UnixNano())
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+name+" OWNER projection_migrator"); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(context.Background(), "DROP DATABASE "+name+" WITH (FORCE)")
	target := databaseURL(t, envOrSkip(t, "PROJECTION_MIGRATION_URL"), name)
	for i := 0; i < 2; i++ {
		if err = migrations.Up(target); err != nil {
			t.Fatal(err)
		}
	}
	conn, err := pgx.Connect(ctx, databaseURL(t, envOrSkip(t, "POSTGRES_ADMIN_URL"), name))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var count int
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') AND NOT relispartition AND relrowsecurity AND relforcerowsecurity`).Scan(&count); err != nil || count != 22 {
		t.Fatal(count, err)
	}
}
func dbEvent(t *testing.T, tenant, device string, v int) map[string]any {
	e := validEvent(t)
	e[fieldTenant] = tenant
	e[fieldAggregate] = device
	e[fieldEvent] = randomUUID()
	e[fieldVersion] = fmt.Sprint(v)
	p := e[fieldPayload].(map[string]any)
	p[fieldDevice] = device
	p["reading_id"] = randomUUID()
	p["source_message_id"] = fmt.Sprint(v)
	p["observed_at"] = time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond).Format(time.RFC3339Nano)
	return e
}
func dbCount(t *testing.T, pool *pgxpool.Pool, tenant, query string, args ...any) int {
	t.Helper()
	var n int
	// Read-only census fixtures also use the read_query role, which has tenant
	// RLS access but no runtime writer admission grant.
	err := common.WithTenantSchema(context.Background(), pool, tenant, "public", func(ctx context.Context, tx pgx.Tx) error { return tx.QueryRow(ctx, query, args...).Scan(&n) })
	if err != nil {
		t.Fatal(err)
	}
	return n
}
func TestDatabaseProjectionReorderCrashReplayIsolation(t *testing.T) {
	pool := dbPool(t)
	s := &Store{DB: pool}
	ctx := context.Background()
	tenant, foreign, device := randomUUID(), randomUUID(), randomUUID()
	observed := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond).Format(time.RFC3339Nano)
	events := applyTelemetryVersions(t, s, tenant, device, []int{42, 40, 41}, func() string { return observed })
	f, err := s.Freshness(ctx, tenant, device)
	if err != nil || f.MaxSeenStreamVersion != "42" || f.ContiguousThroughVersion != "0" || !f.HasKnownGap {
		t.Fatal(f, err)
	}
	earlier := make([]int, 0, 39)
	for v := 1; v < 40; v++ {
		earlier = append(earlier, v)
	}
	events = append(events, applyTelemetryVersions(t, s, tenant, device, earlier, func() string {
		return time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Microsecond).Format(time.RFC3339Nano)
	})...)
	f, err = s.Freshness(ctx, tenant, device)
	if err != nil || f.HasKnownGap || f.ContiguousThroughVersion != "42" {
		t.Fatal(f, err)
	}
	for _, e := range events {
		m := message(e)
		m.Value, _ = json.MarshalIndent(e, "", "  ")
		if err = s.Apply(ctx, m, e); !errors.Is(err, ErrDuplicate) {
			t.Fatal(err)
		}
	}
	if n := dbCount(t, pool, tenant, "SELECT count(*) FROM reading_history WHERE tenant_id=$1", tenant); n != 42 {
		t.Fatal(n)
	}
	if n := dbCount(t, pool, tenant, "SELECT selected_stream_version FROM device_latest WHERE tenant_id=$1 AND device_id=$2", tenant, device); n != 42 {
		t.Fatal(n)
	}
	collision := events[0]
	collision[fieldPayload].(map[string]any)["source_message_id"] = "changed"
	if err = s.Apply(ctx, message(collision), collision); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	assertForeignProjectionWritesDenied(t, pool, tenant, foreign, device, events[0])
	assertCrashBeforeNotificationRollsBack(t, s, pool, tenant, device)
}

// applyTelemetryVersions applies one telemetry event per version with the
// observed_at value returned by observedAt, in the given order.
func applyTelemetryVersions(t *testing.T, s *Store, tenant, device string, versions []int, observedAt func() string) []map[string]any {
	t.Helper()
	events := make([]map[string]any, 0, len(versions))
	for _, v := range versions {
		e := dbEvent(t, tenant, device, v)
		e[fieldPayload].(map[string]any)["observed_at"] = observedAt()
		if err := s.Apply(context.Background(), message(e), e); err != nil {
			t.Fatal(v, err)
		}
		events = append(events, e)
	}
	return events
}

// Runtime role cannot see, update or create another tenant's rows, even without an application filter.
func assertForeignProjectionWritesDenied(t *testing.T, pool *pgxpool.Pool, tenant, foreign, device string, first map[string]any) {
	t.Helper()
	ctx := context.Background()
	if n := dbCount(t, pool, foreign, "SELECT count(*) FROM reading_history WHERE tenant_id=$1", tenant); n != 0 {
		t.Fatal("cross tenant read", n)
	}
	err := WithTenant(ctx, pool, foreign, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, "UPDATE reading_history SET inventory_enrichment='applied' WHERE tenant_id=$1", tenant)
		if tag.RowsAffected() != 0 {
			t.Fatal("foreign update")
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = WithTenant(ctx, pool, foreign, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, "INSERT INTO projection_streams(tenant_id,device_id,stream) VALUES($1,$2,'inventory')", tenant, randomUUID())
		return err
	})
	assertSQLState(t, err, "42501")
	if databaseReason(err) != "" {
		t.Fatal("RLS must remain a hard error")
	}
	// Composite FK disallows a foreign reading even under the caller's valid tenant.
	err = WithTenant(ctx, pool, foreign, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO device_latest(tenant_id,device_id,reading_id,event_id,selected_observed_at,selected_stream_version,max_seen_stream_version,contiguous_through_version) VALUES($1,$2,$3,$4,now(),1,1,1)`, foreign, device, first[fieldPayload].(map[string]any)["reading_id"], first[fieldEvent])
		return err
	})
	assertSQLState(t, err, "23503")
}

// A crash after inbox/history/latest but before notification rolls back all effects.
func assertCrashBeforeNotificationRollsBack(t *testing.T, s *Store, pool *pgxpool.Pool, tenant, device string) {
	t.Helper()
	ctx := context.Background()
	e := dbEvent(t, tenant, device, 43)
	crash := &Store{DB: crashDB{pool}}
	if err := crash.Apply(ctx, message(e), e); !errors.Is(err, errTest) {
		t.Fatal(err)
	}
	if n := dbCount(t, pool, tenant, "SELECT count(*) FROM reading_history WHERE tenant_id=$1", tenant); n != 42 {
		t.Fatal("partial commit")
	}
	if err := s.Apply(ctx, message(e), e); err != nil {
		t.Fatal(err)
	}
	// A committed effect with no broker commit is safely redelivered.
	if err := s.Apply(ctx, message(e), e); !errors.Is(err, ErrDuplicate) {
		t.Fatal(err)
	}
}

type crashDB struct{ TxStarter }

func (d crashDB) BeginTx(ctx context.Context, o pgx.TxOptions) (pgx.Tx, error) {
	tx, err := d.TxStarter.BeginTx(ctx, o)
	return &crashTx{tx}, err
}

type crashTx struct{ pgx.Tx }

func (t *crashTx) Exec(ctx context.Context, q string, args ...any) (pgconn.CommandTag, error) {
	if strings.Contains(q, "INSERT INTO projection_notifications") {
		return pgconn.CommandTag{}, errTest
	}
	return t.Tx.Exec(ctx, q, args...)
}
func TestDatabaseInventoryGapEnrichment(t *testing.T) {
	pool := dbPool(t)
	s := &Store{DB: pool}
	ctx := context.Background()
	tenant, device := randomUUID(), randomUUID()
	reading := dbEvent(t, tenant, device, 1)
	if err := s.Apply(ctx, message(reading), reading); err != nil {
		t.Fatal(err)
	}
	kinds := []string{typeRegistered, typeBinding, typeStatus}
	events := []map[string]any{}
	for i, kind := range kinds {
		e := inventory(t, kind, fmt.Sprint(i+1))
		e[fieldTenant] = tenant
		e[fieldAggregate] = device
		e[fieldEvent] = randomUUID()
		e[fieldPayload].(map[string]any)[fieldDevice] = device
		events = append(events, e)
	}
	for _, i := range []int{2, 0, 1} {
		e := events[i]
		if err := s.Apply(ctx, message(e), e); err != nil {
			t.Fatal(err)
		}
	}
	if n := dbCount(t, pool, tenant, "SELECT inventory_version FROM device_views WHERE tenant_id=$1 AND device_id=$2", tenant, device); n != 3 {
		t.Fatal(n)
	}
	if n := dbCount(t, pool, tenant, "SELECT count(*) FROM reading_history WHERE tenant_id=$1 AND inventory_enrichment='applied'", tenant); n != 1 {
		t.Fatal(n)
	}
	// Older distinct event versions cannot overwrite the materialized view.
	if err := s.Apply(ctx, message(events[0]), events[0]); !errors.Is(err, ErrDuplicate) {
		t.Fatal(err)
	}
}

func assertSQLState(t *testing.T, err error, code string) {
	t.Helper()
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != code {
		t.Fatalf("want SQLSTATE %s, got %v", code, err)
	}
}
