package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
	"greenguard.local/projection-builder/history"
	"greenguard.local/projection-builder/migrations"
)

func replayTestDB(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	admin, err := pgx.Connect(ctx, envOrSkip(t, "POSTGRES_ADMIN_URL"))
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("greenguard_read_replay_test_%d", time.Now().UnixNano())
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+name+" OWNER projection_migrator"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		admin.Exec(context.Background(), "DROP DATABASE "+name+" WITH (FORCE)")
		admin.Close(context.Background())
	})
	if err = migrations.Up(databaseURL(t, envOrSkip(t, "PROJECTION_MIGRATION_URL"), name)); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(databaseURL(t, envOrSkip(t, "PROJECTION_DIRECT_URL"), name))
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	configureFixturePlacement(t, cfg)
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// mustOK fails the test immediately on a non-nil error.
func mustOK(t *testing.T, err error, context ...any) {
	t.Helper()
	if err != nil {
		t.Fatal(append([]any{err}, context...)...)
	}
}

// produceAt0 writes each event to partition 0 of its topic.
func produceAt0(t *testing.T, ctx context.Context, client *kgo.Client, events ...map[string]any) []Message {
	t.Helper()
	out := make([]Message, 0, len(events))
	for _, e := range events {
		m := message(e)
		mustOK(t, client.ProduceSync(ctx, &kgo.Record{Topic: m.Topic, Partition: 0, Key: m.Key, Value: m.Value, Headers: m.Headers}).FirstErr())
		out = append(out, m)
	}
	return out
}

func mustBounds(t *testing.T, ctx context.Context, client *kgo.Client) []replayPartition {
	t.Helper()
	parts, err := replayBounds(ctx, client)
	mustOK(t, err)
	return parts
}

func mustEventMap(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	event, err := decode(raw)
	mustOK(t, err)
	return event.(map[string]any)
}

// provisionTestVersion creates a random read_v<N> schema that is dropped on cleanup.
func provisionTestVersion(t *testing.T, ctx context.Context, migrationURL string) string {
	t.Helper()
	version := fmt.Sprintf("read_v%d", time.Now().UnixNano()%900000000+100000000)
	mustOK(t, migrations.ProvisionVersion(ctx, migrationURL, version))
	t.Cleanup(func() {
		conn, err := pgx.Connect(context.Background(), migrationURL)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(context.Background())
		if _, err := conn.Exec(context.Background(), "DROP SCHEMA "+version+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	return version
}

// globalReplayRunner builds an all-tenant runner that writes to schema.
func globalReplayRunner(t *testing.T, c *testCluster, pool *pgxpool.Pool, store *Store, schema string) *replayRunner {
	t.Helper()
	return &replayRunner{Client: kafkaTestClient(t, c, kgo.ConsumeResetOffset(kgo.NoResetOffset())), Store: store, Tenant: "all", Group: "greenguard.projection-builder." + schema, Validator: testProcessor(t), Apply: store.Apply, Save: replaySave(pool, infrastructureTenant, schema), RecordTenant: replayRecordTenant(pool, schema)}
}

// useClusterDialer routes newKafka clients through the in-process cluster.
func useClusterDialer(t *testing.T, c *testCluster) {
	t.Helper()
	oldMakeClient := makeClient
	makeClient = func(opts ...kgo.Opt) (kafkaClient, error) {
		return oldMakeClient(append(opts, kgo.Dialer(c.network.DialContext))...)
	}
	t.Cleanup(func() { makeClient = oldMakeClient })
}

// followerFor returns a single-attempt processor reading from writer into store.
func followerFor(t *testing.T, writer *Kafka, store *Store) *Processor {
	t.Helper()
	follower := testProcessor(t)
	follower.Source, follower.Sink, follower.Apply, follower.Heartbeat = writer, writer, store.Apply, store.Heartbeat
	follower.Attempts, follower.ProcessTimeout = 1, 5*time.Second
	return follower
}

func requireFrontier(t *testing.T, parts []replayPartition, message string) {
	t.Helper()
	for _, p := range parts {
		if p.Next != p.End {
			t.Fatal(message, p)
		}
	}
}

// saveRecordedFrontier stores every non-empty partition end as durable progress.
func saveRecordedFrontier(t *testing.T, ctx context.Context, save func(context.Context, replayPartition) error, parts []replayPartition) {
	t.Helper()
	for _, p := range parts {
		p.Next = p.End
		if p.Next > 0 {
			mustOK(t, save(ctx, p))
		}
	}
}

// assertTenantRows requires one tenant row per table and none visible to foreign.
// foreignArg is the tenant_id filter used for the foreign-context query.
func assertTenantRows(t *testing.T, pool *pgxpool.Pool, prefix, tenant, foreign, foreignArg string, tables ...string) {
	t.Helper()
	for _, table := range tables {
		if got := dbCount(t, pool, tenant, "SELECT count(*) FROM "+prefix+table+" WHERE tenant_id=$1", tenant); got != 1 {
			t.Fatal(table, got)
		}
		if got := dbCount(t, pool, foreign, "SELECT count(*) FROM "+prefix+table+" WHERE tenant_id=$1", foreignArg); got != 0 {
			t.Fatal("cross tenant", table, got)
		}
	}
}

// Uses an empty in-process broker and disposable read schema so global progress
// cannot be certified by a checkpoint seeded from a shared broker's frontier.
func TestGlobalVersionedReplayFromZero(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	version := provisionTestVersion(t, ctx, envOrSkip(t, "PROJECTION_MIGRATION_URL"))
	pool := dbPool(t)
	c := cluster(t)
	producer := kafkaTestClient(t, c, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	tenants := []string{randomUUID(), randomUUID()}
	produceAt0(t, ctx, producer, dbEvent(t, tenants[0], randomUUID(), 1), dbEvent(t, tenants[1], randomUUID(), 1))
	parts := mustBounds(t, ctx, producer)
	for _, part := range parts {
		if part.Start != 0 || part.Next != 0 {
			t.Fatal("global replay was not started at zero", part)
		}
	}
	mustOK(t, replayManifest(ctx, pool, infrastructureTenant, parts, history.DefaultWindow, version))
	store := &Store{DB: pool, Schema: version, HistoryWindow: history.DefaultWindow}
	mustOK(t, globalReplayRunner(t, c, pool, store, version).run(ctx, parts))
	resumed := mustBounds(t, ctx, producer)
	mustOK(t, replayProgress(ctx, pool, infrastructureTenant, resumed, version))
	requireFrontier(t, resumed, "global frontier incomplete")
	mustOK(t, compareAllShadow(ctx, pool, io.Discard, version))
	for _, tenant := range tenants {
		if n := dbCount(t, pool, tenant, "SELECT count(*) FROM "+version+".consumer_inbox WHERE tenant_id=$1", tenant); n != 1 {
			t.Fatal("tenant event missing", tenant, n)
		}
	}
	if n := dbCount(t, pool, tenants[0], "SELECT count(*) FROM "+version+".consumer_inbox WHERE tenant_id=$1", tenants[1]); n != 0 {
		t.Fatal("cross-tenant read", n)
	}
	// The continuous versioned writer resumes the global replay group and
	// processes an event appended after the rebuild frontier.
	useClusterDialer(t, c)
	writer, err := newKafka(c.ListenAddrs(), "greenguard.projection-builder."+version)
	mustOK(t, err)
	defer writer.Close()
	produceAt0(t, ctx, producer, dbEvent(t, tenants[0], randomUUID(), 1))
	follower := followerFor(t, writer, store)
	next, err := writer.Next(ctx)
	mustOK(t, err)
	if next.Offset != resumed[0].End && next.Topic == resumed[0].Topic && next.Partition == resumed[0].Partition {
		t.Fatalf("versioned writer did not resume replay frontier: %d", next.Offset)
	}
	mustOK(t, follower.process(ctx, next))
	if n := dbCount(t, pool, tenants[0], "SELECT count(*) FROM "+version+".reading_history WHERE tenant_id=$1", tenants[0]); n != 2 {
		t.Fatalf("post-frontier event missing: %d", n)
	}
}

// Exercises the actual replay entry point against a disposable version in the
// shared read database. It never switches readers or alters public projection data.
func TestLiveVersionedReplay(t *testing.T) {
	if os.Getenv("PROJECTION_LIVE_VERSION_REPLAY") != "1" {
		t.Skip("set PROJECTION_LIVE_VERSION_REPLAY=1 for live version acceptance")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	version := provisionTestVersion(t, ctx, envOrSkip(t, "PROJECTION_MIGRATION_URL"))
	brokers := envOrSkip(t, "KAFKA_BROKERS")
	client, err := kgo.NewClient(kgo.SeedBrokers(strings.Split(brokers, ",")...), kgo.RecordPartitioner(kgo.ManualPartitioner()))
	mustOK(t, err)
	defer client.Close()
	tenant, foreign := randomUUID(), randomUUID()
	// The shared live broker contains records from earlier fault tests. Preserve
	// the recorded frontier so this test certifies incremental versioned replay.
	before := mustBounds(t, ctx, client)
	pool := dbPool(t)
	saveRecordedFrontier(t, ctx, replaySave(pool, tenant, version), before)
	produceAt0(t, ctx, client, dbEvent(t, tenant, randomUUID(), 1), dbEvent(t, foreign, randomUUID(), 1))
	overrides := map[string]string{"PROJECTION_REPLAY_ACTION": "rebuild", "PROJECTION_REPLAY_TENANT": tenant, "PROJECTION_REPLAY_SCHEMA": version}
	getenv := func(key string) string {
		if value, ok := overrides[key]; ok {
			return value
		}
		return os.Getenv(key)
	}
	var output bytes.Buffer
	mustOK(t, runReplay(ctx, getenv, &output), output.String())
	overrides["PROJECTION_REPLAY_ACTION"] = "compare"
	output.Reset()
	mustOK(t, runReplay(ctx, getenv, &output), output.String())
	if !strings.Contains(output.String(), `"equal":true`) {
		t.Fatal(output.String())
	}
	assertTenantRows(t, pool, version+".", tenant, foreign, tenant, "consumer_inbox", "reading_history", "device_latest")
	if got := dbCount(t, pool, tenant, "SELECT count(*) FROM public.consumer_inbox WHERE tenant_id=$1", tenant); got != 0 {
		t.Fatal("public inbox changed", got)
	}
	t.Log("PASS versioned replay: command rebuild/compare, isolated tenant, durable versioned state, public untouched")
}

func TestDatabaseReplayShadowResumeIsolation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := replayTestDB(t, ctx)
	c := cluster(t)
	producer := kafkaTestClient(t, c, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	tenant, foreign, device := randomUUID(), randomUUID(), randomUUID()
	e := dbEvent(t, tenant, device, 1)
	other := dbEvent(t, foreign, randomUUID(), 1)
	for _, event := range []map[string]any{e, e, other} {
		m := message(event)
		if err := producer.ProduceSync(ctx, &kgo.Record{Topic: m.Topic, Partition: 0, Key: m.Key, Value: m.Value, Headers: m.Headers}).FirstErr(); err != nil {
			t.Fatal(err)
		}
	}
	parts, err := replayBounds(ctx, producer)
	if err != nil {
		t.Fatal(err)
	}
	if err = replayManifest(ctx, pool, tenant, parts, history.DefaultWindow); err != nil {
		t.Fatal(err)
	}
	store := &Store{DB: pool}
	runner := &replayRunner{Client: kafkaTestClient(t, c, kgo.ConsumeResetOffset(kgo.NoResetOffset())), Tenant: tenant, Group: "shadow-" + tenant, Validator: testProcessor(t), Apply: store.Apply}
	durable := replaySave(pool, tenant)
	// Simulate process death immediately after SQL effect commit, before progress
	// and Kafka commit. Restart reloads DB progress and redelivers idempotently.
	runner.Save = func(context.Context, replayPartition) error { return errTest }
	if err = runner.run(ctx, parts); !errors.Is(err, errTest) {
		t.Fatal(err)
	}
	if got := dbCount(t, pool, tenant, "SELECT count(*) FROM reading_history WHERE tenant_id=$1", tenant); got != 1 {
		t.Fatal(got)
	}
	parts, err = replayBounds(ctx, producer)
	if err != nil {
		t.Fatal(err)
	}
	if err = replayProgress(ctx, pool, tenant, parts); err != nil {
		t.Fatal(err)
	}
	runner.Client = kafkaTestClient(t, c, kgo.ConsumeResetOffset(kgo.NoResetOffset()))
	runner.Save = durable
	if err = runner.run(ctx, parts); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"consumer_inbox", "reading_history", "device_latest", "projection_notifications"} {
		if got := dbCount(t, pool, tenant, "SELECT count(*) FROM "+table+" WHERE tenant_id=$1", tenant); got != 1 {
			t.Fatal(table, got)
		}
		if got := dbCount(t, pool, foreign, "SELECT count(*) FROM "+table+" WHERE tenant_id=$1", foreign); got != 0 {
			t.Fatal("foreign event replayed", table, got)
		}
	}
	if got := dbCount(t, pool, foreign, "SELECT count(*) FROM projection_replay_manifest WHERE tenant_id=$1", tenant); got != 0 {
		t.Fatal("cross-tenant manifest access", got)
	}
	if err = replayManifest(ctx, pool, tenant, parts, 2*history.DefaultWindow); err == nil {
		t.Fatal("changed history window accepted")
	}
	parts[0].TopicID[0] ^= 1
	if err = replayManifest(ctx, pool, tenant, parts, history.DefaultWindow); err == nil {
		t.Fatal("recreated source topic accepted")
	}
	parts[0].TopicID[0] ^= 1
	resumed, err := replayBounds(ctx, producer)
	if err != nil {
		t.Fatal(err)
	}
	if err = replayProgress(ctx, pool, tenant, resumed); err != nil {
		t.Fatal(err)
	}
	for _, p := range resumed {
		if p.Next != p.End {
			t.Fatal("durable frontier", p)
		}
	}
	t.Log("PASS isolated shadow: duplicate/restart once-in-effect, selected tenant only, manifest RLS, source identity/window guard, durable frontier")
}

// This is incremental replay at a recorded real-broker frontier for a newly
// generated tenant. It does NOT certify rebuilding all historical tenants.
func TestLiveDatabaseReplayResume(t *testing.T) {
	if os.Getenv("PROJECTION_LIVE_REPLAY") != "1" {
		t.Skip("set PROJECTION_LIVE_REPLAY=1 for real Kafka acceptance")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool := replayTestDB(t, ctx)
	brokers := strings.Split(envOrSkip(t, "KAFKA_BROKERS"), ",")
	client, err := kgo.NewClient(kgo.SeedBrokers(brokers...), kgo.RecordPartitioner(kgo.ManualPartitioner()), kgo.ConsumeResetOffset(kgo.NoResetOffset()))
	mustOK(t, err)
	defer client.Close()
	parts := mustBounds(t, ctx, client)
	tenant, foreign := randomUUID(), randomUUID()
	mustOK(t, replayManifest(ctx, pool, tenant, parts, history.DefaultWindow))
	// Record the pre-fixture frontier before the tenant's first event exists.
	saveRecordedFrontier(t, ctx, replaySave(pool, tenant), parts)
	event := dbEvent(t, tenant, randomUUID(), 1)
	produceAt0(t, ctx, client, event, event, dbEvent(t, foreign, randomUUID(), 1))
	parts = mustBounds(t, ctx, client)
	mustOK(t, replayProgress(ctx, pool, tenant, parts))
	store := &Store{DB: pool}
	runner := &replayRunner{Client: client, Tenant: tenant, Group: pool.Config().ConnConfig.Database + "-" + tenant, Validator: testProcessor(t), Apply: store.Apply, Save: func(context.Context, replayPartition) error { return errTest }}
	if err = runner.run(ctx, parts); !errors.Is(err, errTest) {
		t.Fatal("crash injection", err)
	}
	// Execute the actual CLI implementation with a fresh Kafka client, then rerun.
	env := map[string]string{"PROJECTION_REPLAY_ACTION": "rebuild", "PROJECTION_REPLAY_TENANT": tenant, "PROJECTION_REPLAY_DATABASE_URL": pool.Config().ConnConfig.ConnString(), "KAFKA_BROKERS": strings.Join(brokers, ","), "EVENT_SCHEMA_DIR": "../../contracts/events"}
	getenv := func(k string) string { return env[k] }
	var output bytes.Buffer
	for i := 0; i < 2; i++ {
		mustOK(t, runReplay(ctx, getenv, &output))
	}
	env["PROJECTION_REPLAY_ACTION"] = "compare"
	if err = runReplay(ctx, getenv, &output); err != nil {
		t.Fatalf("shadow comparison failed: %v; output=%s", err, output.String())
	}
	assertTenantRows(t, pool, "", tenant, foreign, foreign, "consumer_inbox", "reading_history", "device_latest", "projection_notifications")
	t.Log("PASS real Kafka + scratch PostgreSQL: captured pre-fixture frontier; effect-commit crash; resume and repeat once-in-effect; foreign tenant excluded; shadow semantic comparison clean")
	t.Log("source fixture events remain in canonical topic; shadow database and its data are removed by test cleanup")
}
