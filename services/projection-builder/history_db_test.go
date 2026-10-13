package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
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
	return scratchHistoryDBConfigured(t, migrate, true)
}
func scratchHistoryDBWithoutFixturePlacement(t *testing.T, migrate bool) historyDatabase {
	return scratchHistoryDBConfigured(t, migrate, false)
}
func scratchHistoryDBConfigured(t *testing.T, migrate, fixturePlacement bool) historyDatabase {
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
	owner := historyPoolConfigured(t, target, fixturePlacement)
	runtime := historyPoolConfigured(t, databaseURL(t, envOrSkip(t, "PROJECTION_DIRECT_URL"), name), fixturePlacement)
	inspection, err := pgx.Connect(ctx, databaseURL(t, envOrSkip(t, "POSTGRES_ADMIN_URL"), name))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = inspection.Close(ctx) })
	return historyDatabase{runtime, owner, inspection, target}
}
func historyPool(t *testing.T, url string) *pgxpool.Pool {
	return historyPoolConfigured(t, url, true)
}
func historyPoolConfigured(t *testing.T, url string, fixturePlacement bool) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	if fixturePlacement {
		configureFixturePlacement(t, cfg)
	}
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
	if err := history.Maintain(context.Background(), historyMaintenancePool(t, db.migrationURL), history.DefaultWindow, 3); err != nil {
		t.Fatal(err)
	}
}

func historyMaintenancePool(t *testing.T, databaseURL string) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.User = "projection_history_maintainer"
	cfg.ConnConfig.Password = envOrSkip(t, "PROJECTION_HISTORY_MAINTAINER_PASSWORD")
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
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
	maintainer := historyMaintenancePool(t, url)
	if err := history.Maintain(ctx, maintainer, history.DefaultWindow, 3, "read_v1"); err != nil {
		t.Fatal(err)
	}
	if n := scalar(t, owner, `SELECT count(*) FROM pg_class WHERE oid=to_regclass($1)`, partition); n != 1 {
		t.Fatal("versioned partition missing")
	}
	if n := scalar(t, owner, `SELECT count(*) FROM pg_inherits WHERE inhparent='public.reading_history'::regclass`); n != publicBefore {
		t.Fatal("public partitions changed")
	}
	if err := history.Maintain(ctx, maintainer, history.DefaultWindow, 3, "read_v1;DROP SCHEMA public"); err == nil {
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
	if after := scalar(t, db.admin, countPartitions); after != before {
		t.Fatal("age-only maintenance must retain expired partitions until cold-store coverage is verified", before, after)
	}
	if scalar(t, db.admin, "SELECT count(*) FROM pg_class WHERE oid=to_regclass($1)", "reading_history_"+now.AddDate(0, 0, -10).UTC().Format("20060102")) != 1 {
		t.Fatal("expired partition was dropped without a Cassandra coverage proof")
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

func TestDatabaseHistoryPruneRequiresCurrentCoverageReceipt(t *testing.T) {
	db := scratchHistoryDB(t, true)
	ctx := context.Background()
	maintainHistory(t, db)
	var now time.Time
	if err := db.admin.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
		t.Fatal(err)
	}
	// Keep the delayed +1h/+2h events within the intended UTC partition,
	// including when this test runs after 22:00 UTC.
	oldDay := now.Add(-10 * 24 * time.Hour).UTC().Truncate(24 * time.Hour)
	partition := "reading_history_" + oldDay.Format("20060102")
	if _, err := db.owner.Exec(ctx, "SELECT projection_history_partition($1::date)", oldDay.Format("2006-01-02")); err != nil {
		t.Fatal(err)
	}
	maintainer := historyMaintenancePool(t, db.migrationURL)
	var directCount int64
	if err := maintainer.QueryRow(ctx, "SELECT count(*) FROM "+pgx.Identifier{partition}.Sanitize()).Scan(&directCount); !postgresCode(err, "42501") {
		t.Fatal("maintenance login acquired direct cross-tenant table access", err)
	}
	tenant, device := randomUUID(), randomUUID()
	event := historyAt(t, tenant, device, 1, oldDay.Add(time.Hour))
	if err := (&Store{DB: db.runtime, HistoryWindow: 3650 * 24 * time.Hour}).Apply(ctx, message(event), event); err != nil {
		t.Fatal(err)
	}
	var reads, sensors int64
	if err := maintainer.QueryRow(ctx, "SELECT reading_rows,sensor_rows FROM projection_history_partition_counts($1)", partition).Scan(&reads, &sensors); err != nil {
		t.Fatal(err)
	}
	if reads != 1 || sensors != 0 {
		t.Fatalf("fixture counts reading=%d sensor=%d", reads, sensors)
	}
	assertHistoryManifestHash(t, ctx, maintainer, partition)
	assertCertifiedHistoryPruning(t, ctx, db, maintainer, partition, oldDay, historyPartitionCounts{readings: reads, sensors: sensors})
	assertStaleHistoryReceiptRetained(t, ctx, db, maintainer, oldDay, tenant, device)
}

func assertHistoryManifestHash(t *testing.T, ctx context.Context, maintainer *pgxpool.Pool, partition string) {
	t.Helper()
	// The verifier hashes UTC JSONB rows in manifest order. The SQL helper
	// must produce the same bytes and ignore the caller's session timezone.
	manifestTx, err := maintainer.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer manifestTx.Rollback(ctx)
	if _, err := manifestTx.Exec(ctx, "SET LOCAL timezone='UTC'"); err != nil {
		t.Fatal(err)
	}
	var manifestJSON string
	if err := manifestTx.QueryRow(ctx, "SELECT to_jsonb(m)::text FROM projection_history_cassandra_manifest($1) m", partition).Scan(&manifestJSON); err != nil {
		t.Fatal(err)
	}
	seed := sha256.Sum256([]byte("greenguard-history-manifest-v2\n"))
	wantHash := fmt.Sprintf("%x", sha256.Sum256(append(seed[:], []byte(manifestJSON+"\n")...)))
	if _, err := manifestTx.Exec(ctx, "SET LOCAL timezone='America/Winnipeg'"); err != nil {
		t.Fatal(err)
	}
	var actualHash string
	if err := manifestTx.QueryRow(ctx, "SELECT projection_history_partition_sha256($1)", partition).Scan(&actualHash); err != nil {
		t.Fatal(err)
	}
	if actualHash != wantHash {
		t.Fatal("manifest hash changed with session timezone or differs from verifier bytes")
	}
	if err := manifestTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
}

// historyPartitionCounts keeps the coverage receipt's paired row counts together.
type historyPartitionCounts struct {
	readings, sensors int64
}

func assertCertifiedHistoryPruning(t *testing.T, ctx context.Context, db historyDatabase, maintainer *pgxpool.Pool, partition string, oldDay time.Time, counts historyPartitionCounts) {
	t.Helper()
	reads, sensors := counts.readings, counts.sensors
	// Legacy-format hashes are syntactically valid but must fail closed and
	// remain candidates for the updated verifier even when counts match.
	if _, err := maintainer.Exec(ctx, "SELECT projection_history_record_cassandra_coverage($1,$2,$3,$4,$5::double precision)", partition, reads, sensors, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", history.DefaultWindow.Seconds()); err != nil {
		t.Fatal(err)
	}
	maintainHistory(t, db)
	if n := scalar(t, db.admin, "SELECT count(*) FROM pg_class WHERE oid=to_regclass($1)", partition); n != 1 {
		t.Fatal("legacy-format receipt allowed pruning")
	}
	if n := scalar(t, maintainer, "SELECT count(*) FROM projection_history_cassandra_candidates($1::double precision) WHERE partition_name=$2", history.DefaultWindow.Seconds(), partition); n != 1 {
		t.Fatal("legacy receipt was not selected for reverification")
	}
	// Unreceipted old partitions must not consume the bounded prune scan.
	if _, err := db.owner.Exec(ctx, "SELECT projection_history_partition($1::date - offset_days) FROM generate_series(2,34) offset_days", oldDay.Format("2006-01-02")); err != nil {
		t.Fatal(err)
	}
	if _, err := maintainer.Exec(ctx, "SELECT projection_history_record_cassandra_coverage($1,$2,$3,$4,$5::double precision)", partition, reads, sensors, partitionHash(t, maintainer, partition), history.DefaultWindow.Seconds()); err != nil {
		t.Fatal(err)
	}
	// A busy older partition must not starve the next eligible partition.
	nextDay := oldDay.Add(24 * time.Hour)
	nextPartition := "reading_history_" + nextDay.Format("20060102")
	if _, err := db.owner.Exec(ctx, "SELECT projection_history_partition($1::date)", nextDay.Format("2006-01-02")); err != nil {
		t.Fatal(err)
	}
	if _, err := maintainer.Exec(ctx, "SELECT projection_history_record_cassandra_coverage($1,0,0,$2,$3::double precision)", nextPartition, partitionHash(t, maintainer, nextPartition), history.DefaultWindow.Seconds()); err != nil {
		t.Fatal(err)
	}
	readerTx, err := db.admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer readerTx.Rollback(ctx)
	if _, err := readerTx.Exec(ctx, "LOCK TABLE "+pgx.Identifier{partition}.Sanitize()+" IN ACCESS SHARE MODE"); err != nil {
		t.Fatal(err)
	}
	maintainHistory(t, db)
	if n := scalar(t, db.owner, "SELECT count(*) FROM pg_class WHERE oid=to_regclass($1)", partition); n != 1 {
		t.Fatal("partition with an active reader was not retained on lock timeout")
	}
	if n := scalar(t, db.owner, "SELECT count(*) FROM pg_class WHERE oid=to_regclass($1)", nextPartition); n != 0 {
		t.Fatal("busy partition prevented pruning the next matching receipt")
	}
	if err := readerTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	maintainHistory(t, db)
	if n := scalar(t, db.admin, "SELECT count(*) FROM pg_class WHERE oid=to_regclass($1)", partition); n != 0 {
		t.Fatal("maintenance did not prune a currently certified read-model partition")
	}
}

func assertStaleHistoryReceiptRetained(t *testing.T, ctx context.Context, db historyDatabase, maintainer *pgxpool.Pool, oldDay time.Time, tenant, device string) {
	t.Helper()
	var reads, sensors int64
	// A new delayed projection row invalidates the prior receipt by changing
	// the partition count. Maintenance must retain it until verification reruns.
	secondDay := oldDay.Add(-24 * time.Hour)
	stalePartition := "reading_history_" + secondDay.Format("20060102")
	if _, err := db.owner.Exec(ctx, "SELECT projection_history_partition($1::date)", secondDay.Format("2006-01-02")); err != nil {
		t.Fatal(err)
	}
	late := historyAt(t, tenant, device, 2, secondDay.Add(time.Hour))
	if err := (&Store{DB: db.runtime, HistoryWindow: 3650 * 24 * time.Hour}).Apply(ctx, message(late), late); err != nil {
		t.Fatal(err)
	}
	if err := maintainer.QueryRow(ctx, "SELECT reading_rows,sensor_rows FROM projection_history_partition_counts($1)", stalePartition).Scan(&reads, &sensors); err != nil {
		t.Fatal(err)
	}
	if _, err := maintainer.Exec(ctx, "SELECT projection_history_record_cassandra_coverage($1,$2,$3,$4,$5::double precision)", stalePartition, reads, sensors, partitionHash(t, maintainer, stalePartition), history.DefaultWindow.Seconds()); err != nil {
		t.Fatal(err)
	}
	// Updating event identity preserves counts but invalidates the content proof.
	if err := WithTenant(ctx, db.owner, tenant, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, "UPDATE "+pgx.Identifier{stalePartition}.Sanitize()+" SET event_id=$1", randomUUID())
		return err
	}); err != nil {
		t.Fatal(err)
	}

	maintainHistory(t, db)
	if n := scalar(t, db.admin, "SELECT count(*) FROM pg_class WHERE oid=to_regclass($1)", stalePartition); n != 1 {
		t.Fatal("same-count content mutation allowed pruning")
	}

	if n := scalar(t, maintainer, "SELECT count(*) FROM projection_history_cassandra_candidates($1::double precision) WHERE partition_name=$2", history.DefaultWindow.Seconds(), stalePartition); n != 1 {
		t.Fatal("same-count mutation was not selected for reverification")
	}
	assertMaintenanceRelationFence(t, ctx, db, maintainer, stalePartition, tenant)

	late = historyAt(t, tenant, device, 3, secondDay.Add(2*time.Hour))
	if err := (&Store{DB: db.runtime, HistoryWindow: 3650 * 24 * time.Hour}).Apply(ctx, message(late), late); err != nil {
		t.Fatal(err)
	}
	maintainHistory(t, db)
	if n := scalar(t, db.admin, "SELECT count(*) FROM pg_class WHERE oid=to_regclass($1)", stalePartition); n != 1 {
		t.Fatal("stale Cassandra coverage receipt allowed read-history pruning")
	}
}

func assertMaintenanceRelationFence(t *testing.T, ctx context.Context, db historyDatabase, maintainer *pgxpool.Pool, stalePartition, tenant string) {
	t.Helper()
	// A maintenance transaction retains its relation locks until commit or
	// rollback, including when it keeps a partition after a hash mismatch.
	maintenanceTx, err := maintainer.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer maintenanceTx.Rollback(ctx)
	if _, err := maintenanceTx.Exec(ctx, "SELECT projection_history_maintain($1::double precision,3)", history.DefaultWindow.Seconds()); err != nil {
		t.Fatal(err)
	}
	if n := scalar(t, db.admin, "SELECT count(*) FROM "+pgx.Identifier{stalePartition}.Sanitize()); n != 1 {
		t.Fatal("maintenance SHARE lock did not preserve reads")
	}
	err = WithTenant(ctx, db.owner, tenant, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout='100ms'"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, "UPDATE "+pgx.Identifier{stalePartition}.Sanitize()+" SET event_id=$1", randomUUID())
		return err
	})
	if !postgresCode(err, "55P03") {
		t.Fatal("ordinary writer was not fenced by maintenance relation lock", err)
	}
	if err := maintenanceTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

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

	notificationTenant := randomUUID()
	err = WithTenant(context.Background(), db.runtime, notificationTenant, func(ctx context.Context, tx pgx.Tx) error {
		// A valid same-transaction watermark reaches the foreign-key rejection
		// instead of failing the independent projection certificate first.
		w, err := advanceProjectionWatermark(ctx, tx, notificationTenant)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO projection_notifications(tenant_id,notification_id,resource_type,resource_id,event_id,purpose,shard_incarnation,placement_epoch,projection_sequence)
 VALUES(current_setting('app.tenant_id')::uuid,$1,'device',$2,$3,'projection_changed',$4,$5,$6)`, randomUUID(), event[fieldAggregate], event[fieldEvent], w.ShardIncarnation, w.PlacementEpoch, w.Sequence)
		return err
	})
	assertSQLState(t, err, "23503")
}
func TestDatabaseHistoryMigrationPreservesDataUntilCassandraCoverage(t *testing.T) {
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
	if dbCount(t, db.runtime, tenant, countHistory, tenant) != 1 {
		t.Fatal("migration or maintenance removed expired history without Cassandra coverage")
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
	if dbCount(t, db.runtime, tenant, countHistory, tenant) != 1 {
		t.Fatal("replay changed retained expired history")
	}
}
func seedUnpartitionedHistory(t *testing.T, db historyDatabase, event map[string]any) {
	t.Helper()
	body, _ := json.Marshal(event)
	p := event[fieldPayload].(map[string]any)
	// Seed the historical schema with its original tenant RLS helper; the new
	// admission function is introduced by the migrations under test.
	err := common.WithTenantSchema(context.Background(), db.runtime, event[fieldTenant].(string), "public", func(ctx context.Context, tx pgx.Tx) error {
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

func partitionHash(t *testing.T, db *pgxpool.Pool, partition string) string {
	t.Helper()
	var hash string
	if err := db.QueryRow(context.Background(), "SELECT projection_history_partition_sha256($1)", partition).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	return hash
}
