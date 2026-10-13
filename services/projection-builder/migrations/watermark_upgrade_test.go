package migrations

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestDatabaseWatermarkUpgradePreservesLegacyWithoutInventedCompletion(t *testing.T) {
	adminURL, ownerURL := os.Getenv("POSTGRES_ADMIN_URL"), os.Getenv("PROJECTION_MIGRATION_URL")
	if adminURL == "" || ownerURL == "" {
		t.Skip("POSTGRES_ADMIN_URL/PROJECTION_MIGRATION_URL unavailable")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	name := fmt.Sprintf("projection_upgrade_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name+" OWNER projection_migrator"); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)")
	cfg, err := pgx.ParseConfig(ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Database = name
	cfg.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	owner, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close(ctx)
	entries, err := files.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".up.sql") || entry.Name() >= "000019" {
			continue
		}
		body, _ := files.ReadFile(entry.Name())
		if _, err := owner.Exec(ctx, string(body)); err != nil {
			t.Fatal(entry.Name(), err)
		}
	}
	const tenant = "22222222-2222-4222-8222-222222222222"
	const event = "33333333-3333-4333-8333-333333333333"
	const incarnation = "44444444-4444-4444-8444-444444444444"
	if _, err := owner.Exec(ctx, `INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,'s1',$2,7,'active')`, tenant, incarnation); err != nil {
		t.Fatal(err)
	}
	tx, err := owner.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{{"app.tenant_id", tenant}, {"app.shard_id", "s1"}, {"app.shard_incarnation", incarnation}, {"app.placement_epoch", "7"}} {
		if _, err := tx.Exec(ctx, `SELECT set_config($1,$2,true)`, pair[0], pair[1]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO consumer_inbox(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event)
 VALUES('projection-builder',$1,$2,'legacy',0,0,jsonb_build_object('event_type','telemetry.recorded','aggregate_type','device','aggregate_id',$1::text,'aggregate_version','42','correlation_id',$2::text,'traceparent','00-11111111111111111111111111111111-1111111111111111-01'))`, tenant, event); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO projection_notifications(tenant_id,notification_id,resource_type,resource_id,event_id,purpose) VALUES($1,$2,'device',$1,$2,'projection_changed')`, tenant, event); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var before string
	if _, err := owner.Exec(ctx, `SELECT set_config('app.tenant_id',$1,false)`, tenant); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT payload::text FROM outbox_events WHERE tenant_id=$1`, tenant).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `SELECT set_config('app.tenant_id','',false)`); err != nil {
		t.Fatal(err)
	}
	body, err := files.ReadFile("000019_projection_watermarks.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, string(body)); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `SELECT set_config('app.tenant_id',$1,false)`, tenant); err != nil {
		t.Fatal(err)
	}
	var after string
	var sequence, completions, legacy int
	if err := owner.QueryRow(ctx, `SELECT payload::text FROM outbox_events WHERE tenant_id=$1`, tenant).Scan(&after); err != nil || before != after {
		t.Fatal("upgrade rewrote legacy notification", err)
	}
	if err := owner.QueryRow(ctx, `SELECT sequence FROM projection_watermarks WHERE tenant_id=$1 AND shard_incarnation=$2 AND placement_epoch=7`, tenant, incarnation).Scan(&sequence); err != nil || sequence != 0 {
		t.Fatal("upgrade invented historical sequence", sequence, err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM projection_event_completions WHERE tenant_id=$1`, tenant).Scan(&completions); err != nil || completions != 0 {
		t.Fatal("upgrade invented source completion", completions, err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM projection_notifications WHERE tenant_id=$1 AND shard_incarnation IS NULL AND projection_sequence IS NULL`, tenant).Scan(&legacy); err != nil || legacy != 1 {
		t.Fatal("upgrade lost legacy notification", legacy, err)
	}
}
