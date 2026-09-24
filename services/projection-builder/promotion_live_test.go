package main

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
	"greenguard.local/projection-builder/history"
	"greenguard.local/projection-builder/migrations"
)

// Entire swap, including the read route, runs in a disposable database and
// against an in-process broker. It never touches shared read.* views.
func TestDisposablePromotionAndPostSwapEvent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool := replayTestDB(t, ctx)
	var database string
	mustOK(t, pool.QueryRow(ctx, `SELECT current_database()`).Scan(&database))
	migrationURL := databaseURL(t, envOrSkip(t, "PROJECTION_MIGRATION_URL"), database)
	schema := "read_v1"
	mustOK(t, migrations.ProvisionVersion(ctx, migrationURL, schema))
	admin, err := pgxpool.New(ctx, databaseURL(t, envOrSkip(t, "POSTGRES_ADMIN_URL"), database))
	mustOK(t, err)
	defer admin.Close()
	c := cluster(t)
	producer := kafkaTestClient(t, c, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	tenant, device := randomUUID(), randomUUID()
	first := produceAt0(t, ctx, producer, dbEvent(t, tenant, device, 1))[0]
	public := &Store{DB: pool, Schema: "public", HistoryWindow: history.DefaultWindow}
	mustOK(t, public.Apply(ctx, first, mustEventMap(t, first.Value)))
	shadow := rebuildAndCompareShadow(t, ctx, c, producer, pool, schema)
	mustOK(t, PromoteReadViews(ctx, admin, schema, CanonicalPromotionVerifier(producer, testProcessor(t))))
	second := produceAt0(t, ctx, producer, dbEvent(t, tenant, device, 2))[0]
	parsed := mustEventMap(t, second.Value)
	mustOK(t, shadow.Apply(ctx, second, parsed))
	duplicate := second
	duplicate.Offset = second.Offset + 1
	if err := shadow.Apply(ctx, duplicate, parsed); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate outcome: %v", err)
	}
	if got := dbCount(t, pool, infrastructureTenant, `SELECT committed_offset FROM read_v1.projection_checkpoints WHERE tenant_id=$1 AND consumer_name='projection-builder-replay' AND topic=$2 AND partition=$3`, infrastructureTenant, second.Topic, second.Partition); got != int(duplicate.Offset) {
		t.Fatalf("duplicate did not advance global frontier: %d", got)
	}
	// Rebuild v2 from the retained canonical source while v1 remains the active
	// writer and reader route. The second promotion is the actual version swap.
	schema = "read_v2"
	mustOK(t, migrations.ProvisionVersion(ctx, migrationURL, schema))
	shadow2 := rebuildAndCompareShadow(t, ctx, c, producer, pool, schema)
	assertLaggingPromotionRejected(t, ctx, pool, admin, producer, schema, second)
	mustOK(t, PromoteReadViews(ctx, admin, schema, CanonicalPromotionVerifier(producer, testProcessor(t))))
	useClusterDialer(t, c)
	writer, err := newKafka(c.ListenAddrs(), "greenguard.projection-builder."+schema)
	mustOK(t, err)
	defer writer.Close()
	third := produceAt0(t, ctx, producer, dbEvent(t, tenant, device, 3))[0]
	follower := followerFor(t, writer, shadow2)
	next, err := writer.Next(ctx)
	mustOK(t, err)
	mustOK(t, follower.process(ctx, next))
	assertPostSwapRoute(t, ctx, admin, schema, tenant, device, mustEventMap(t, third.Value))
}

// rebuildAndCompareShadow replays all tenants into schema, compares it and
// gives the returned store a writer lease.
func rebuildAndCompareShadow(t *testing.T, ctx context.Context, c *testCluster, producer *kgo.Client, pool *pgxpool.Pool, schema string) *Store {
	t.Helper()
	parts := mustBounds(t, ctx, producer)
	mustOK(t, replayManifest(ctx, pool, infrastructureTenant, parts, history.DefaultWindow, schema))
	shadow := &Store{DB: pool, Schema: schema, HistoryWindow: history.DefaultWindow}
	mustOK(t, globalReplayRunner(t, c, pool, shadow, schema).run(ctx, parts))
	mustOK(t, compareAllShadow(ctx, pool, io.Discard, schema))
	lease, err := acquireWriterLease(ctx, pool, schema)
	mustOK(t, err)
	shadow.Lease = lease
	return shadow
}

// A live reader cutover must reject a target whose durable source frontier
// trails Kafka even when its writer holds a healthy lease.
func assertLaggingPromotionRejected(t *testing.T, ctx context.Context, pool, admin *pgxpool.Pool, producer *kgo.Client, schema string, last Message) {
	t.Helper()
	mustOK(t, WithTenantSchema(ctx, pool, infrastructureTenant, schema, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE projection_checkpoints SET committed_offset=0 WHERE tenant_id=$1 AND consumer_name=$2 AND topic=$3 AND partition=$4`, infrastructureTenant, replayConsumer, last.Topic, last.Partition)
		return err
	}))
	if err := PromoteReadViews(ctx, admin, schema, CanonicalPromotionVerifier(producer, testProcessor(t))); err == nil {
		t.Fatal("promotion accepted a lagging global checkpoint")
	}
	mustOK(t, replaySave(pool, infrastructureTenant, schema)(ctx, replayPartition{Topic: last.Topic, Partition: last.Partition, Next: 2}))
}

func assertPostSwapRoute(t *testing.T, ctx context.Context, admin *pgxpool.Pool, schema, tenant, device string, parsed map[string]any) {
	t.Helper()
	tx, err := admin.Begin(ctx)
	mustOK(t, err)
	defer tx.Rollback(context.Background())
	active, err := activeReadSchema(ctx, tx)
	if err != nil || active != schema {
		t.Fatalf("route %s: %v", active, err)
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM read.reading_history WHERE tenant_id=$1 AND device_id=$2`, tenant, device).Scan(&count); err != nil || count != 3 {
		t.Fatalf("post-swap history count %d: %v", count, err)
	}
	var latest int
	if err := tx.QueryRow(ctx, `SELECT selected_stream_version FROM read.device_latest WHERE tenant_id=$1 AND device_id=$2`, tenant, device).Scan(&latest); err != nil || latest != 3 {
		t.Fatalf("post-swap latest %d: %v", latest, err)
	}
	var latestReading string
	if err := tx.QueryRow(ctx, `SELECT reading_id::text FROM read.latest_readings WHERE tenant_id=$1 AND device_id=$2`, tenant, device).Scan(&latestReading); err != nil || latestReading != parsed[fieldPayload].(map[string]any)["reading_id"] {
		t.Fatalf("post-swap latest payload %s: %v", latestReading, err)
	}
}
