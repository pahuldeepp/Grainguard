package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	redislib "github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
)

// Opt-in proof against the shared local Kafka and Redis Cluster. It creates a
// unique consumer group, leaves existing offsets untouched, and compares only
// keys belonging to two unique tenants.
func TestLiveKafkaRedisCommittedInvalidation(t *testing.T) {
	if os.Getenv("CACHE_INVALIDATOR_LIVE") != "1" {
		t.Skip("CACHE_INVALIDATOR_LIVE=1 required")
	}
	getenv := os.Getenv
	addresses := brokers(getenv)
	if len(addresses) == 0 {
		t.Fatal("KAFKA_BROKERS required")
	}
	redis, err := newRedis(getenv, 250*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer redis.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := redis.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	producer, err := kgo.NewClient(kgo.SeedBrokers(addresses...), kgo.RequiredAcks(kgo.AllISRAcks()))
	if err != nil {
		t.Fatal(err)
	}
	defer producer.Close()
	group := "cache-invalidator-live-" + randomSuffix(t)
	source, err := newKafka(addresses, group)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	tenantA, tenantB := "liveA"+randomSuffix(t), "liveB"+randomSuffix(t)
	device := "device" + randomSuffix(t)
	keys := []string{deviceVersionKey(tenantA, device), generationKey(tenantB)}
	before := make([]string, len(keys))
	for i, key := range keys {
		before[i], err = redis.client.Get(ctx, key).Result()
		if err != nil && !errors.Is(err, redislib.Nil) {
			t.Fatal(err)
		}
	}
	publishLiveNotification(t, ctx, producer, tenantA, scopeDevice, device)
	publishLiveNotification(t, ctx, producer, tenantB, scopeTenant, "")
	worker := testWorker(&fakeSource{}, &fakeBumper{})
	worker.Source = source
	worker.Bumper = redis
	worker.Settings.Concurrency = 2
	processed := flushLiveNotifications(t, ctx, source, worker, 2)
	if processed != 2 {
		t.Fatalf("processed %d/2 notifications", processed)
	}
	for i, key := range keys {
		after, err := redis.client.Get(ctx, key).Result()
		if err != nil || after == before[i] || after == "" {
			t.Fatalf("key %s not advanced: before=%q after=%q err=%v", key, before[i], after, err)
		}
	}
}

func publishLiveNotification(t *testing.T, ctx context.Context, producer *kgo.Client, tenant, scope, id string) {
	t.Helper()
	data, err := json.Marshal(map[string]any{"event_type": notificationType, "tenant_id": tenant,
		"occurred_at": time.Now().UTC().Format(time.RFC3339Nano), "payload": map[string]string{"scope": scope, "resource_id": id}})
	if err != nil {
		t.Fatal(err)
	}
	if err := producer.ProduceSync(ctx, &kgo.Record{Topic: notificationTopic, Key: []byte(tenant), Value: data}).FirstErr(); err != nil {
		t.Fatal(err)
	}
}

func flushLiveNotifications(t *testing.T, ctx context.Context, source *Kafka, worker *Worker, expected int) int {
	t.Helper()
	processed := 0
	for processed < expected && ctx.Err() == nil {
		pollCtx, stop := context.WithTimeout(ctx, time.Second)
		records, err := source.Poll(pollCtx, 100)
		stop()
		if err != nil {
			t.Fatal(err)
		}
		if len(records) == 0 {
			continue
		}
		b := newBatch()
		for _, record := range records {
			b.add(record)
			processed++
		}
		if err := worker.flush(ctx, b); err != nil {
			t.Fatal(err)
		}
	}
	return processed
}

func randomSuffix(t *testing.T) string {
	t.Helper()
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b[:])
}

func TestLiveRedisOutageRecoveryKeepsKafkaOffset(t *testing.T) {
	if os.Getenv("CACHE_INVALIDATOR_LIVE") != "1" {
		t.Skip("CACHE_INVALIDATOR_LIVE=1 required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	good, err := newRedis(os.Getenv, 250*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer good.Close()
	bad, err := newRedis(func(key string) string {
		if key == "READ_REDIS_URL" {
			return "redis://127.0.0.1:7199"
		}
		return ""
	}, 50*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer bad.Close()
	addresses := brokers(os.Getenv)
	producer, err := kgo.NewClient(kgo.SeedBrokers(addresses...), kgo.RequiredAcks(kgo.AllISRAcks()))
	if err != nil {
		t.Fatal(err)
	}
	defer producer.Close()
	tenant := "outage" + randomSuffix(t)
	device := "device" + randomSuffix(t)
	record := notificationRecord(t, tenant, scopeDevice, device)
	if err := producer.ProduceSync(ctx, &kgo.Record{Topic: notificationTopic, Key: []byte(tenant), Value: record.Value}).FirstErr(); err != nil {
		t.Fatal(err)
	}
	source, err := newKafka(addresses, "cache-outage-proof-"+tenant)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	matched := pollTenantNotification(t, ctx, source, tenant)
	if matched == nil {
		t.Fatal("outage notification not observed")
	}
	b := newBatch()
	b.add(*matched)
	w := testWorker(&fakeSource{}, &fakeBumper{})
	w.Source = source
	w.Bumper = bad
	w.Settings.OpTimeout = 50 * time.Millisecond
	if err := w.flush(ctx, b); !errors.Is(err, errInvalidationUnconfirmed) {
		t.Fatalf("outage flush=%v", err)
	}
	if w.Metrics.commits.Load() != 0 {
		t.Fatal("Kafka offset committed during Redis outage")
	}
	w.Bumper = good
	if err := w.flush(ctx, b); err != nil {
		t.Fatal(err)
	}
	if w.Metrics.commits.Load() != 1 {
		t.Fatal("Kafka offset was not committed after Redis recovery")
	}
	if value, err := good.client.Get(ctx, deviceVersionKey(tenant, device)).Result(); err != nil || value == "" {
		t.Fatalf("device stamp absent: %q %v", value, err)
	}
	t.Logf("tenant %s: offset held during refused Redis connection, then committed after epoch and device bump", tenant)
}

func pollTenantNotification(t *testing.T, ctx context.Context, source *Kafka, tenant string) *Record {
	t.Helper()
	for ctx.Err() == nil {
		pollCtx, stop := context.WithTimeout(ctx, time.Second)
		received, err := source.Poll(pollCtx, 100)
		stop()
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range received {
			target, err := parseTarget(item.Value)
			if err == nil && target.Tenant == tenant {
				return &item
			}
		}
		source.AllowRebalance()
	}
	return nil
}
