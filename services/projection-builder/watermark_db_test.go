package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"greenguard.local/projection-builder/migrations"
)

func seedProjectionOwnership(t *testing.T, db historyDatabase, tenant, incarnation string) {
	t.Helper()
	_, err := db.admin.Exec(context.Background(), `INSERT INTO greenguard_internal.tenant_ownership
 (tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,'s2',$2,9007199254740993,'active')
 ON CONFLICT(tenant_id) DO NOTHING`, tenant, incarnation)
	if err != nil {
		t.Fatal(err)
	}
}

func TestDatabaseProjectionWatermarkAtomicIdentityAndIsolation(t *testing.T) {
	db := scratchHistoryDBWithoutFixturePlacement(t, true)
	ctx := context.Background()
	if err := migrations.Up(db.migrationURL); err != nil {
		t.Fatal(err)
	}
	tenant, foreign, incarnation := randomUUID(), randomUUID(), randomUUID()
	store := &Store{DB: db.runtime}
	e := dbEvent(t, tenant, randomUUID(), 42)
	// A fully migrated, initially unseeded database denies traffic and preserves
	// the empty watermark. An explicit durable import makes it available at zero.
	if err := store.Apply(ctx, message(e), e); !postgresCode(err, "42501") {
		t.Fatalf("missing ownership admitted: %v", err)
	}
	seedProjectionOwnership(t, db, tenant, incarnation)
	seedProjectionOwnership(t, db, foreign, incarnation)
	if n := scalar(t, db.admin, `SELECT sequence FROM projection_watermarks WHERE tenant_id=$1`, tenant); n != 0 {
		t.Fatal("new durable ownership did not initialize sequence zero", n)
	}
	if err := store.Apply(ctx, message(e), e); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := db.admin.QueryRow(ctx, `SELECT payload FROM outbox_events WHERE tenant_id=$1`, tenant).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if payload["shard_incarnation"] != incarnation || payload["placement_epoch"] != "9007199254740993" || payload["projection_sequence"] != "1" || payload["source_version"] != "42" {
		t.Fatalf("incorrect notification identity: %v", payload)
	}
	if n := scalar(t, db.admin, `SELECT count(*) FROM projection_event_completions WHERE tenant_id=$1 AND event_id=$2 AND source_version=42 AND projection_sequence=1`, tenant, e[fieldEvent]); n != 1 {
		t.Fatal("exact telemetry event completion missing")
	}
	if err := store.Apply(ctx, message(e), e); !errors.Is(err, ErrDuplicate) {
		t.Fatal(err)
	}
	if n := scalar(t, db.admin, `SELECT sequence FROM projection_watermarks WHERE tenant_id=$1`, tenant); n != 1 {
		t.Fatal("duplicate incremented sequence", n)
	}
	rollbackEvent := dbEvent(t, tenant, randomUUID(), 1)
	err := WithTenant(ctx, db.runtime, tenant, func(ctx context.Context, tx pgx.Tx) error {
		skipped, duplicate := false, false
		if err := store.applyInTx(ctx, tx, message(rollbackEvent), rollbackEvent, &skipped, &duplicate); err != nil {
			return err
		}
		return errTest // after real notification/outbox insert, before commit
	})
	if !errors.Is(err, errTest) {
		t.Fatal(err)
	}
	if n := scalar(t, db.admin, `SELECT sequence FROM projection_watermarks WHERE tenant_id=$1`, tenant); n != 1 {
		t.Fatal("rollback exposed increment", n)
	}
	for _, table := range []string{"consumer_inbox", "projection_event_completions", "projection_notifications", "outbox_events"} {
		if n := scalar(t, db.admin, "SELECT count(*) FROM "+table+" WHERE tenant_id=$1", tenant); n != 1 {
			t.Fatal("rollback exposed rows", table, n)
		}
	}
	for _, table := range []string{"projection_watermarks", "projection_event_completions"} {
		if n := dbCount(t, db.runtime, foreign, "SELECT count(*) FROM "+table+" WHERE tenant_id=$1", tenant); n != 0 {
			t.Fatal("cross tenant read", table)
		}
	}
	err = WithTenant(ctx, db.runtime, tenant, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO projection_watermarks(tenant_id,shard_incarnation,placement_epoch,sequence) VALUES($1,$2,9007199254740993,0)`, foreign, incarnation)
		return err
	})
	if !postgresCode(err, "42501") {
		t.Fatal("cross tenant write admitted", err)
	}
	err = WithTenant(ctx, db.runtime, tenant, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO projection_event_completions
 (tenant_id,consumer_name,event_id,aggregate_type,aggregate_id,source_version,source_event_type,shard_incarnation,placement_epoch,projection_sequence)
 VALUES($1,'projection-builder',$2,'device',$3,1,'telemetry.recorded',$4,9007199254740993,1)`, foreign, randomUUID(), randomUUID(), incarnation)
		return err
	})
	if !postgresCode(err, "42501") {
		t.Fatal("cross tenant completion write admitted", err)
	}
	err = WithTenant(ctx, db.runtime, tenant, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO projection_watermarks(tenant_id,shard_incarnation,placement_epoch,sequence) VALUES($1,$2,2,0)`, tenant, randomUUID())
		return err
	})
	if !postgresCode(err, "42501") {
		t.Fatal("invented projection identity admitted", err)
	}
	// A producer deployed before 000019 cannot commit effects while leaving a
	// previous visibility sequence unchanged, even if it supplies that sequence.
	oldEvent := dbEvent(t, tenant, randomUUID(), 1)
	err = WithTenant(ctx, db.runtime, tenant, func(ctx context.Context, tx pgx.Tx) error {
		if err := insertInbox(ctx, tx, message(oldEvent), oldEvent); err != nil {
			return err
		}
		skipped := false
		if err := applyEffect(ctx, tx, oldEvent, store.historyWindow(), &skipped); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO projection_notifications
 (tenant_id,notification_id,resource_type,resource_id,event_id,purpose,shard_incarnation,placement_epoch,projection_sequence)
 VALUES($1,$2,'device',$3,$2,'projection_changed',$4,9007199254740993,1)`, tenant, oldEvent[fieldEvent], oldEvent[fieldAggregate], incarnation)
		return err
	})
	if !postgresCode(err, "55000") {
		t.Fatal("old producer reused committed sequence", err)
	}
	if n := scalar(t, db.admin, `SELECT count(*) FROM consumer_inbox WHERE tenant_id=$1`, tenant); n != 1 {
		t.Fatal("old producer effects committed without watermark")
	}
	if n := scalar(t, db.admin, `SELECT count(*) FROM pg_class WHERE oid IN ('projection_watermarks'::regclass,'projection_event_completions'::regclass) AND relrowsecurity AND relforcerowsecurity`); n != 2 {
		t.Fatal("watermark/completion RLS not forced")
	}
	var valid bool
	if err := db.admin.QueryRow(ctx, `SELECT has_table_privilege('read_query','projection_watermarks','SELECT')
 AND NOT has_table_privilege('read_query','projection_watermarks','INSERT')
 AND NOT has_table_privilege('projection_app','projection_event_completions','UPDATE')
 AND NOT has_table_privilege('projection_app','projection_watermarks','DELETE')`).Scan(&valid); err != nil || !valid {
		t.Fatal("watermark/completion grants too broad", err)
	}
}

func postgresCode(err error, code string) bool {
	var dbErr *pgconn.PgError
	return errors.As(err, &dbErr) && dbErr.Code == code
}

func TestDatabaseProjectionWatermarkSerializesConcurrentAggregates(t *testing.T) {
	db := scratchHistoryDBWithoutFixturePlacement(t, true)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	tenant := randomUUID()
	seedProjectionOwnership(t, db, tenant, randomUUID())
	store := &Store{DB: db.runtime}
	first, second := dbEvent(t, tenant, randomUUID(), 1), dbEvent(t, tenant, randomUUID(), 1)
	ready, release := make(chan struct{}), make(chan struct{})
	firstDone, secondDone := make(chan error, 1), make(chan error, 1)
	var once sync.Once
	defer once.Do(func() { close(release) })
	go func() {
		firstDone <- WithTenant(ctx, db.runtime, tenant, func(ctx context.Context, tx pgx.Tx) error {
			skipped, duplicate := false, false
			if err := store.applyInTx(ctx, tx, message(first), first, &skipped, &duplicate); err != nil {
				return err
			}
			close(ready)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	select {
	case <-ready:
	case err := <-firstDone:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	go func() { secondDone <- store.Apply(ctx, message(second), second) }()
	select {
	case err := <-secondDone:
		t.Fatal("second aggregate escaped the tenant serialization lock", err)
	case <-time.After(100 * time.Millisecond):
	}
	if n := scalar(t, db.admin, `SELECT sequence FROM projection_watermarks WHERE tenant_id=$1`, tenant); n != 0 {
		t.Fatal("uncommitted sequence became visible", n)
	}
	once.Do(func() { close(release) })
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	if err := <-secondDone; err != nil {
		t.Fatal(err)
	}
	if n := scalar(t, db.admin, `SELECT sequence FROM projection_watermarks WHERE tenant_id=$1`, tenant); n != 2 {
		t.Fatal("serialized commits not contiguous", n)
	}
	if n := scalar(t, db.admin, `SELECT count(DISTINCT projection_sequence) FROM projection_event_completions WHERE tenant_id=$1`, tenant); n != 2 {
		t.Fatal("events did not receive distinct committed sequences", n)
	}
}

func TestDatabaseProjectionInventoryCompletionWaitsForFold(t *testing.T) {
	db := scratchHistoryDBWithoutFixturePlacement(t, true)
	tenant, device := randomUUID(), randomUUID()
	seedProjectionOwnership(t, db, tenant, randomUUID())
	store := &Store{DB: db.runtime}
	legacyTelemetry := dbEvent(t, tenant, device, 1)
	// A retained legacy telemetry inbox identity has no certified completion.
	// Inventory folding must never manufacture its proof from another stream.
	if err := WithTenant(context.Background(), db.runtime, tenant, func(ctx context.Context, tx pgx.Tx) error {
		return insertInbox(ctx, tx, message(legacyTelemetry), legacyTelemetry)
	}); err != nil {
		t.Fatal(err)
	}
	events := make([]map[string]any, 3)
	for n, kind := range []string{typeRegistered, typeBinding, typeStatus} {
		e := inventory(t, kind, fmt.Sprint(n+1))
		e[fieldTenant], e[fieldAggregate], e[fieldEvent] = tenant, device, randomUUID()
		e[fieldPayload].(map[string]any)[fieldDevice] = device
		events[n] = e
	}
	for _, index := range []int{2, 0, 1} {
		e := events[index]
		if err := store.Apply(context.Background(), message(e), e); err != nil {
			t.Fatal(err)
		}
		if index != 1 {
			if n := scalar(t, db.admin, `SELECT count(*) FROM projection_event_completions WHERE tenant_id=$1 AND event_id=$2`, tenant, events[2][fieldEvent]); n != 0 {
				t.Fatal("pending delta incorrectly certified by max seen")
			}
		}
	}
	if n := scalar(t, db.admin, `SELECT count(*) FROM projection_event_completions WHERE tenant_id=$1 AND event_id=$2`, tenant, legacyTelemetry[fieldEvent]); n != 0 {
		t.Fatal("inventory fold certified legacy telemetry", n)
	}
	if n := scalar(t, db.admin, `SELECT count(*) FROM projection_event_completions WHERE tenant_id=$1 AND source_version IN (2,3) AND projection_sequence=3`, tenant); n != 2 {
		t.Fatal("gap fill did not certify each newly folded exact event", n)
	}
}

func TestDatabaseProjectionWatermarkVersionPromotionAndOutbox(t *testing.T) {
	ctx := context.Background()
	pool := replayTestDB(t, ctx)
	var database string
	if err := pool.QueryRow(ctx, `SELECT current_database()`).Scan(&database); err != nil {
		t.Fatal(err)
	}
	url := databaseURL(t, envOrSkip(t, "PROJECTION_MIGRATION_URL"), database)
	admin, err := pgx.Connect(ctx, databaseURL(t, envOrSkip(t, "POSTGRES_ADMIN_URL"), database))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	db := historyDatabase{runtime: pool, admin: admin, migrationURL: url}
	tenant, incarnation := randomUUID(), randomUUID()
	seedProjectionOwnership(t, db, tenant, incarnation)
	seedProjectionOwnership(t, db, infrastructureTenant, incarnation)
	if err := migrations.ProvisionVersion(ctx, url, "read_v1"); err != nil {
		t.Fatal(err)
	}
	if n := scalar(t, admin, `SELECT sequence FROM read_v1.projection_watermarks WHERE tenant_id=$1`, tenant); n != 0 {
		t.Fatal("provisioned version lacks durable empty identity")
	}
	verified := func(context.Context, pgx.Tx, string) (PromotionProof, error) { return fullPromotionProof(), nil }
	if err := WithTenant(ctx, admin, tenant, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM read_v1.projection_watermarks WHERE tenant_id=$1`, tenant)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := PromoteReadViews(ctx, admin, "read_v1", verified); !postgresCode(err, "P0002") {
		t.Fatal("promotion accepted absent target watermark", err)
	}
	if _, err := admin.Exec(ctx, `UPDATE greenguard_internal.tenant_ownership SET updated_at=updated_at WHERE tenant_id=$1`, tenant); err != nil {
		t.Fatal(err)
	}
	live, shadow := &Store{DB: pool}, &Store{DB: pool, Schema: "read_v1"}
	first, second := dbEvent(t, tenant, randomUUID(), 1), dbEvent(t, tenant, randomUUID(), 1)
	for _, store := range []*Store{live, shadow} {
		if err := store.Apply(ctx, message(first), first); err != nil {
			t.Fatal(err)
		}
	}
	if n := scalar(t, admin, `SELECT count(*) FROM outbox_events WHERE tenant_id=$1`, tenant); n != 1 {
		t.Fatal("inactive replay published notification", n)
	}
	if err := live.Apply(ctx, message(second), second); err != nil {
		t.Fatal(err)
	}
	if err := PromoteReadViews(ctx, admin, "read_v1", verified); !postgresCode(err, "55000") {
		t.Fatal("promotion accepted missing exact completion coverage", err)
	}
	if err := shadow.Apply(ctx, message(second), second); err != nil {
		t.Fatal(err)
	}
	// An extra committed visibility boundary with no row change makes the old
	// sequence greater while both projections/completions remain identical.
	if err := WithTenant(ctx, pool, tenant, func(ctx context.Context, tx pgx.Tx) error {
		_, err := advanceProjectionWatermark(ctx, tx, tenant)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := PromoteReadViews(ctx, admin, "read_v1", verified); err != nil {
		t.Fatal(err)
	}
	if n := scalar(t, admin, `SELECT sequence FROM read.projection_watermarks WHERE tenant_id=$1`, tenant); n != 3 {
		t.Fatal("promotion lowered visibility sequence", n)
	}
	third := dbEvent(t, tenant, randomUUID(), 1)
	if err := shadow.Apply(ctx, message(third), third); err != nil {
		t.Fatal(err)
	}
	if n := scalar(t, admin, `SELECT count(*) FROM public.outbox_events WHERE tenant_id=$1 AND projection_schema='read_v1' AND payload->>'projection_sequence'='4' AND payload->>'shard_incarnation'=$2`, tenant, incarnation); n != 1 {
		t.Fatal("active version failed to publish transactional watermark", n)
	}
	if n := scalar(t, admin, `SELECT count(*) FROM public.outbox_events WHERE tenant_id=$1 AND payload->>'scope'='epoch' AND payload->>'projection_sequence'='1' AND payload->>'placement_epoch'='9007199254740993'`, infrastructureTenant); n != 1 {
		t.Fatal("promotion lacks separate infrastructure notification identity", n)
	}
	// Promotion swaps the data and watermark route together. The runtime read
	// role sees that route under forced RLS without mutation/admission privileges.
	tx, err := admin.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL ROLE read_query`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenant); err != nil {
		t.Fatal(err)
	}
	var got string
	if err := tx.QueryRow(ctx, `SELECT sequence::text FROM read.projection_watermarks WHERE tenant_id=$1 AND shard_incarnation=$2 AND placement_epoch=9007199254740993`, tenant, incarnation).Scan(&got); err != nil || got != "4" {
		t.Fatal("promoted snapshot missing watermark", got, err)
	}
	if err := tx.QueryRow(ctx, `SELECT shard_incarnation::text FROM greenguard_internal.projection_ownership_snapshot($1)`, tenant).Scan(&got); err != nil || got != incarnation {
		t.Fatal("read-only ownership snapshot rejected", got, err)
	}
}

func TestDatabaseProjectionBootstrapUsesExplicitTenantOwnership(t *testing.T) {
	db := scratchHistoryDBWithoutFixturePlacement(t, true)
	ctx := context.Background()
	tenant, incarnation := randomUUID(), randomUUID()
	call := func(query string, args ...any) error {
		tx, err := db.admin.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SET LOCAL ROLE tenant_ownership_bootstrap`); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if _, err := db.admin.Exec(ctx, `SELECT greenguard_internal.seed_projection_infrastructure_ownership('s2',$1,9007199254740993)`, incarnation); err != nil {
		t.Fatal(err)
	}
	if err := call(`SELECT greenguard_internal.prepare_tenant_ownership($1,'s2',$2,9007199254740993)`, tenant, incarnation); err != nil {
		t.Fatal("explicit tenant preparation failed", err)
	}
	if n := scalar(t, db.admin, `SELECT count(*) FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1 AND state='prepared'`, tenant); n != 1 {
		t.Fatal("tenant was not prepared exactly once", n)
	}
	if err := call(`SELECT greenguard_internal.activate_tenant_ownership($1,'s2',$2,9007199254740993)`, tenant, incarnation); err != nil {
		t.Fatal("explicit tenant activation failed", err)
	}
	if err := call(`SELECT greenguard_internal.activate_tenant_ownership($1,'s2',$2,9007199254740993)`, tenant, incarnation); err != nil {
		t.Fatal("activation retry was not idempotent", err)
	}
	if n := scalar(t, db.admin, `SELECT count(*) FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1 AND state='active'`, tenant); n != 1 {
		t.Fatal("tenant did not become active", n)
	}
	if n := scalar(t, db.admin, `SELECT count(*) FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1 AND state='active'`, infrastructureTenant); n != 1 {
		t.Fatal("tenant bootstrap changed infrastructure ownership", n)
	}
	if err := call(`SELECT greenguard_internal.prepare_tenant_ownership($1,'s3',$2,9007199254740993)`, tenant, randomUUID()); err == nil {
		t.Fatal("bootstrap silently moved an already placed tenant")
	}
	if err := call(`SELECT greenguard_internal.seed_tenant_ownership('[]'::jsonb,'s2',$1,0)`, incarnation); !postgresCode(err, "42501") {
		t.Fatal("retired snapshot importer remains callable by the bootstrap role", err)
	}
}
