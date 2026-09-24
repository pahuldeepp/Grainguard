package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"greenguard.local/projection-builder/history"
	"greenguard.local/projection-builder/migrations"
)

// Retention tests own a scratch database: never prune the coordinator's dev DB.
type historyDatabase struct {
	runtime, owner *pgxpool.Pool
	admin          *pgx.Conn
	migrationURL   string
}

func scratchHistoryDB(t *testing.T, migrate bool) historyDatabase {
	t.Helper()
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, envOrSkip(t, "POSTGRES_ADMIN_URL"))
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("projection_history_test_%d", time.Now().UnixNano())
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+name+" OWNER projection_migrator"); err != nil {
		admin.Close(ctx)
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)"); _ = admin.Close(ctx) })
	target := databaseURL(t, envOrSkip(t, "PROJECTION_MIGRATION_URL"), name)
	if migrate {
		if err = migrations.Up(target); err != nil {
			t.Fatal(err)
		}
	}
	owner := historyPool(t, target)
	runtime := historyPool(t, databaseURL(t, envOrSkip(t, "PROJECTION_DIRECT_URL"), name))
	inspection, err := pgx.Connect(ctx, databaseURL(t, envOrSkip(t, "POSTGRES_ADMIN_URL"), name))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = inspection.Close(ctx) })
	return historyDatabase{runtime, owner, inspection, target}
}
func historyPool(t *testing.T, url string) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}
func scalar(t *testing.T, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, q string, args ...any) int {
	t.Helper()
	var n int
	if err := db.QueryRow(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
func maintainHistory(t *testing.T, db historyDatabase) {
	t.Helper()
	if err := history.Maintain(context.Background(), db.owner, history.DefaultWindow, 3); err != nil {
		t.Fatal(err)
	}
}

func TestVersionedHistoryMaintenanceTargetsOnlyRequestedSchema(t *testing.T) {
	ctx := context.Background()
	pool := replayTestDB(t, ctx)
	var database string
	if err := pool.QueryRow(ctx, `SELECT current_database()`).Scan(&database); err != nil {
		t.Fatal(err)
	}
	url := databaseURL(t, envOrSkip(t, "PROJECTION_MIGRATION_URL"), database)
	if err := migrations.ProvisionVersion(ctx, url, "read_v1"); err != nil {
		t.Fatal(err)
	}
	owner := historyPool(t, url)
	day := time.Now().UTC().AddDate(0, 0, 3).Format("20060102")
	partition := "read_v1.reading_history_" + day
	if _, err := owner.Exec(ctx, "DROP TABLE "+partition); err != nil {
		t.Fatal(err)
	}
	if n := scalar(t, owner, `SELECT count(*) FROM pg_class WHERE oid=to_regclass($1)`, partition); n != 0 {
		t.Fatal("partition not removed")
	}
	publicBefore := scalar(t, owner, `SELECT count(*) FROM pg_inherits WHERE inhparent='public.reading_history'::regclass`)
	if err := history.Maintain(ctx, owner, history.DefaultWindow, 3, "read_v1"); err != nil {
		t.Fatal(err)
	}
	if n := scalar(t, owner, `SELECT count(*) FROM pg_class WHERE oid=to_regclass($1)`, partition); n != 1 {
		t.Fatal("versioned partition missing")
	}
	if n := scalar(t, owner, `SELECT count(*) FROM pg_inherits WHERE inhparent='public.reading_history'::regclass`); n != publicBefore {
		t.Fatal("public partitions changed")
	}
	if err := history.Maintain(ctx, owner, history.DefaultWindow, 3, "read_v1;DROP SCHEMA public"); err == nil {
		t.Fatal("invalid schema accepted")
	}
}
func historyAt(t *testing.T, tenant, device string, v int, at time.Time) map[string]any {
	t.Helper()
	e := dbEvent(t, tenant, device, v)
	e[fieldPayload].(map[string]any)["observed_at"] = at.UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)
	return e
}

const countHistory = "SELECT count(*) FROM reading_history WHERE tenant_id=$1"
const countPartitions = "SELECT count(*) FROM pg_inherits WHERE inhparent='reading_history'::regclass"

func TestDatabaseHistoryPartitionMaintenance(t *testing.T) {
	db := scratchHistoryDB(t, true)
	ctx := context.Background()
	maintainHistory(t, db)
	var now time.Time
	if err := db.admin.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
		t.Fatal(err)
	}
	// Create one expired partition and one intersecting the safety boundary.
	old := now.Add(-10 * 24 * time.Hour).UTC().Format("2006-01-02")
	if _, err := db.owner.Exec(ctx, "SELECT projection_history_partition($1::date)", old); err != nil {
		t.Fatal(err)
	}
	before := scalar(t, db.admin, countPartitions)
	maintainHistory(t, db)
	if after := scalar(t, db.admin, countPartitions); after != before-1 {
		t.Fatal("only expired partition should drop", before, after)
	}
	stable := scalar(t, db.admin, countPartitions)
	maintainHistory(t, db)
	if scalar(t, db.admin, countPartitions) != stable {
		t.Fatal("maintenance not idempotent")
	}
	assertHistoryPartitions(t, db, now)
	assertHistoryBoundary(t, db)
	tenant, device := randomUUID(), randomUUID()
	event := historyAt(t, tenant, device, 1, now.Add(-time.Minute))
	store := &Store{DB: db.runtime}
	if err := store.Apply(ctx, message(event), event); err != nil {
		t.Fatal(err)
	}
	partition := "reading_history_" + now.Add(-time.Minute).UTC().Format("20060102")
	foreign := randomUUID()
	query := "SELECT count(*) FROM " + pgx.Identifier{partition}.Sanitize() + " WHERE tenant_id=$1"
	if dbCount(t, db.runtime, foreign, query, tenant) != 0 {
		t.Fatal("direct partition leaked tenant")
	}
	if dbCount(t, db.runtime, tenant, query, tenant) != 1 {
		t.Fatal("owner tenant cannot read partition")
	}
	for _, table := range []string{"reading_history", partition} {
		err := WithTenant(ctx, db.runtime, tenant, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, "DELETE FROM "+pgx.Identifier{table}.Sanitize()+" WHERE tenant_id=$1", tenant)
			return err
		})
		assertSQLState(t, err, "42501")
	}
	err := history.Maintain(ctx, db.runtime, history.DefaultWindow, 3)
	assertSQLState(t, err, "42501")
}
func assertHistoryPartitions(t *testing.T, db historyDatabase, now time.Time) {
	t.Helper()
	// Every partition including days ahead has forced RLS and its own policy.
	bad := scalar(t, db.admin, `SELECT count(*) FROM pg_class c WHERE (c.oid='reading_history'::regclass OR c.oid IN
 (SELECT inhrelid FROM pg_inherits WHERE inhparent='reading_history'::regclass))
 AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'))`)
	if bad != 0 {
		t.Fatal("unprotected partition", bad)
	}
	if scalar(t, db.admin, `SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace
 AND relkind IN ('r','p') AND has_table_privilege('projection_app',oid,'DELETE')`) != 0 {
		t.Fatal("runtime DELETE granted")
	}
	for _, day := range []time.Time{now.Add(-25 * time.Hour), now, now.Add(3 * 24 * time.Hour)} {
		name := "reading_history_" + day.UTC().Format("20060102")
		if scalar(t, db.admin, "SELECT count(*) FROM pg_class WHERE oid=to_regclass($1)", name) != 1 {
			t.Fatal("missing hot/ahead partition", name)
		}
	}
}
func TestDatabaseHistoryLateReplayAndMovedForeignKeys(t *testing.T) {
	db := scratchHistoryDB(t, true)
	ctx := context.Background()
	tenant, device := randomUUID(), randomUUID()
	store := &Store{DB: db.runtime, HistoryWindow: time.Hour}
	old := historyAt(t, tenant, device, 1, time.Now().Add(-10*24*time.Hour))
	if err := store.Apply(ctx, message(old), old); err != nil {
		t.Fatal(err)
	}
	if dbCount(t, db.runtime, tenant, countHistory, tenant) != 0 || store.HistoryOutOfWindow.Load() != 1 {
		t.Fatal("late history retained or uncounted")
	}
	if dbCount(t, db.runtime, tenant, "SELECT selected_stream_version FROM device_latest WHERE tenant_id=$1 AND device_id=$2", tenant, device) != 1 {
		t.Fatal("late latest lost")
	}
	if err := store.Apply(ctx, message(old), old); !errors.Is(err, ErrDuplicate) {
		t.Fatal(err)
	}
	if store.HistoryOutOfWindow.Load() != 1 {
		t.Fatal("duplicate late reading counted twice")
	}
	recent := historyAt(t, tenant, device, 2, time.Now().Add(-time.Minute))
	if err := store.Apply(ctx, message(recent), recent); err != nil {
		t.Fatal(err)
	}
	late := historyAt(t, tenant, device, 3, time.Now().Add(-2*time.Hour))
	if err := store.Apply(ctx, message(late), late); err != nil {
		t.Fatal(err)
	}
	if dbCount(t, db.runtime, tenant, countHistory, tenant) != 1 {
		t.Fatal("configured cutoff ignored")
	}
	if dbCount(t, db.runtime, tenant, "SELECT selected_stream_version FROM device_latest WHERE tenant_id=$1 AND device_id=$2", tenant, device) != 2 {
		t.Fatal("late reading regressed latest")
	}
	if dbCount(t, db.runtime, tenant, "SELECT max_seen_stream_version FROM device_latest WHERE tenant_id=$1 AND device_id=$2", tenant, device) != 3 {
		t.Fatal("late version lost")
	}
	assertHistoryForeignKeys(t, db, tenant, recent)
	// Missing future partition is an operational hard error, not poison quarantine.
	future := historyAt(t, tenant, device, 4, time.Now().Add(40*24*time.Hour))
	err := store.Apply(ctx, message(future), future)
	assertSQLState(t, err, "55000")
	if databaseReason(err) != "" {
		t.Fatal("missing partition quarantined")
	}
	if dbCount(t, db.runtime, tenant, "SELECT count(*) FROM consumer_inbox WHERE tenant_id=$1", tenant) != 3 {
		t.Fatal("partial missing-partition commit")
	}
}
func assertHistoryForeignKeys(t *testing.T, db historyDatabase, tenant string, event map[string]any) {
	t.Helper()
	if scalar(t, db.admin, `SELECT count(*) FROM pg_constraint WHERE contype='f' AND confrelid='reading_history'::regclass`) != 0 {
		t.Fatal("history still referenced")
	}
	if scalar(t, db.admin, `SELECT count(*) FROM pg_constraint WHERE contype='f' AND confrelid='consumer_inbox'::regclass AND conrelid IN ('device_latest'::regclass,'projection_notifications'::regclass)`) != 2 {
		t.Fatal("missing inbox FKs")
	}
	foreign := randomUUID()
	err := WithTenant(context.Background(), db.runtime, foreign, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO device_latest(tenant_id,device_id,reading_id,event_id,selected_observed_at,selected_stream_version,max_seen_stream_version,contiguous_through_version)
 VALUES($1,$2,$3,$4,now(),1,1,1)`, foreign, event[fieldAggregate], event[fieldPayload].(map[string]any)["reading_id"], event[fieldEvent])
		return err
	})
	assertSQLState(t, err, "23503")
	// Same-tenant event with a forged reading is also rejected by the moved FK.
	err = WithTenant(context.Background(), db.runtime, tenant, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, "UPDATE device_latest SET reading_id=$3 WHERE tenant_id=$1 AND device_id=$2", tenant, event[fieldAggregate], randomUUID())
		return err
	})
	assertSQLState(t, err, "23503")

	err = WithTenant(context.Background(), db.runtime, randomUUID(), func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO projection_notifications(tenant_id,notification_id,resource_type,resource_id,event_id,purpose)
 VALUES(current_setting('app.tenant_id')::uuid,$1,'device',$2,$3,'projection_changed')`, randomUUID(), event[fieldAggregate], event[fieldEvent])
		return err
	})
	assertSQLState(t, err, "23503")
}
func TestDatabaseHistoryMigrationPreservesDataThenPrunes(t *testing.T) {
	db := scratchHistoryDB(t, false)
	ctx := context.Background()
	sql, err := os.ReadFile("migrations/000001_projection.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.owner.Exec(ctx, string(sql)); err != nil {
		t.Fatal(err)
	}
	tenant, device := randomUUID(), randomUUID()
	event := historyAt(t, tenant, device, 1, time.Now().Add(-10*24*time.Hour))
	seedUnpartitionedHistory(t, db, event)
	if _, err = db.owner.Exec(ctx, "CREATE TABLE schema_migrations(version bigint NOT NULL PRIMARY KEY, dirty boolean NOT NULL); INSERT INTO schema_migrations VALUES(1,false)"); err != nil {
		t.Fatal(err)
	}
	if err = migrations.Up(db.migrationURL); err != nil {
		t.Fatal(err)
	}
	if dbCount(t, db.runtime, tenant, countHistory, tenant) != 1 {
		t.Fatal("migration lost existing data")
	}
	maintainHistory(t, db)
	if dbCount(t, db.runtime, tenant, countHistory, tenant) != 0 {
		t.Fatal("expired data retained")
	}
	for _, table := range []string{"consumer_inbox", "device_latest", "projection_notifications"} {
		if dbCount(t, db.runtime, tenant, "SELECT count(*) FROM "+table+" WHERE tenant_id=$1", tenant) != 1 {
			t.Fatal("retention lost durable reference", table)
		}
	}
	store := &Store{DB: db.runtime}
	if err = store.Apply(ctx, message(event), event); !errors.Is(err, ErrDuplicate) {
		t.Fatal(err)
	}
	if dbCount(t, db.runtime, tenant, countHistory, tenant) != 0 {
		t.Fatal("replay resurrected history")
	}
}
func seedUnpartitionedHistory(t *testing.T, db historyDatabase, event map[string]any) {
	t.Helper()
	body, _ := json.Marshal(event)
	p := event[fieldPayload].(map[string]any)
	err := WithTenant(context.Background(), db.runtime, event[fieldTenant].(string), func(ctx context.Context, tx pgx.Tx) error {
		queries := []struct {
			sql  string
			args []any
		}{
			{`INSERT INTO consumer_inbox(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event) VALUES($1,$2,$3,$4,0,0,$5)`, []any{consumerName, event[fieldTenant], event[fieldEvent], topicTelemetry, string(body)}},
			{`INSERT INTO reading_history(tenant_id,reading_id,device_id,event_id,stream_version,source_message_id,site_id,observed_at,received_at,inventory_enrichment) VALUES($1,$2,$3,$4,1,'seed',$5,$6,$6,'pending')`, []any{event[fieldTenant], p["reading_id"], event[fieldAggregate], event[fieldEvent], p["site_id"], p["observed_at"]}},
			{`INSERT INTO device_latest(tenant_id,device_id,reading_id,event_id,selected_observed_at,selected_stream_version,max_seen_stream_version,contiguous_through_version) VALUES($1,$2,$3,$4,$5,1,1,1)`, []any{event[fieldTenant], event[fieldAggregate], p["reading_id"], event[fieldEvent], p["observed_at"]}},
			{`INSERT INTO projection_notifications(tenant_id,notification_id,resource_type,resource_id,event_id,purpose) VALUES($1,$2,'device',$3,$2,'projection_changed')`, []any{event[fieldTenant], event[fieldEvent], event[fieldAggregate]}},
		}
		for _, q := range queries {
			if _, err := tx.Exec(ctx, q.sql, q.args...); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func assertHistoryBoundary(t *testing.T, db historyDatabase) {
	t.Helper()
	if scalar(t, db.runtime, `SELECT count(*) FROM (VALUES
  (projection_history_accepts(statement_timestamp()-interval '1 hour',3600),true),
  (projection_history_accepts(statement_timestamp()-interval '1 hour 1 microsecond',3600),false)) AS checks(actual,expected)
 WHERE actual=expected`) != 2 {
		t.Fatal("hot/cold boundary mismatch")
	}
}
func TestDatabaseHistoryInboxIdentityAfterExpiry(t *testing.T) {
	db := scratchHistoryDB(t, true)
	ctx := context.Background()
	tenant, device := randomUUID(), randomUUID()
	store := &Store{DB: db.runtime}
	old := historyAt(t, tenant, device, 1, time.Now().Add(-10*24*time.Hour))
	if err := store.Apply(ctx, message(old), old); err != nil {
		t.Fatal(err)
	}
	conflict := historyAt(t, tenant, device, 1, time.Now().Add(-time.Minute))
	assertSQLState(t, store.Apply(ctx, message(conflict), conflict), "23505")
	conflict = historyAt(t, tenant, device, 2, time.Now().Add(-time.Minute))
	conflict[fieldPayload].(map[string]any)["reading_id"] = old[fieldPayload].(map[string]any)["reading_id"]
	assertSQLState(t, store.Apply(ctx, message(conflict), conflict), "23505")
	if dbCount(t, db.runtime, tenant, countHistory, tenant) != 0 {
		t.Fatal("identity conflict resurrected history")
	}
}
