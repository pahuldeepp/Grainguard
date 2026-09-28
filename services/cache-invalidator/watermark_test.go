package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/redis/go-redis/v9"
	"os"
	"testing"
	"time"
)

const watermarkTenant = "11111111-1111-4111-8111-111111111111"
const watermarkIncarnation = "22222222-2222-4222-8222-222222222222"

func watermarkRecord(t *testing.T, device, sequence string) Record {
	t.Helper()
	value, err := json.Marshal(map[string]any{"event_type": notificationType, "tenant_id": watermarkTenant, "occurred_at": time.Now().UTC().Format(time.RFC3339Nano), "payload": map[string]string{"scope": scopeDevice, "resource_id": device, "shard_incarnation": watermarkIncarnation, "placement_epoch": "5", "projection_sequence": sequence}})
	if err != nil {
		t.Fatal(err)
	}
	return Record{Value: value}
}
func TestWatermarkBatchPreservesTenantMaximumAcrossDeviceAndEpochCoalescing(t *testing.T) {
	b := newBatch()
	b.add(watermarkRecord(t, "device-a", "9007199254740993"))
	b.add(watermarkRecord(t, "device-b", "9007199254740994"))
	b.add(watermarkRecord(t, "device-b", "9007199254740992"))
	if len(b.watermarks) != 1 || len(b.targets()) != 2 {
		t.Fatal(b.watermarks, b.targets())
	}
	for _, target := range b.watermarks {
		if target.Sequence != "9007199254740994" || target.Scope != scopeTenant || target.Device != "" {
			t.Fatal(target)
		}
	}
	epoch := Target{Scope: scopeEpoch}
	b.epoch = &epoch
	if len(b.watermarks) != 1 || len(b.targets()) != 1 {
		t.Fatal("global invalidation lost committed minimum")
	}
}

type watermarkBumper struct {
	fakeBumper
	failAdvance bool
	advances    []Target
}

func (b *watermarkBumper) Advance(_ context.Context, t Target) error {
	if b.failAdvance {
		return errors.New("unconfirmed watermark")
	}
	b.advances = append(b.advances, t)
	return nil
}
func TestWatermarkFailureNeverCommitsOffsetsEvenAfterNamespaceRecovery(t *testing.T) {
	src := &fakeSource{}
	bumper := &watermarkBumper{failAdvance: true}
	w := testWorker(src, &bumper.fakeBumper)
	w.Bumper = bumper
	b := newBatch()
	b.add(watermarkRecord(t, "device-a", "10"))
	for i := 0; i < 2; i++ {
		if !errors.Is(w.flush(context.Background(), b), errInvalidationUnconfirmed) {
			t.Fatal("failure acknowledged")
		}
	}
	if src.commits != 0 {
		t.Fatal("offset committed before watermark confirmation")
	}
	bumper.failAdvance = false
	if err := w.flush(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if src.commits != 1 || len(bumper.advances) != 1 {
		t.Fatal(src.commits, bumper.advances)
	}
}
func TestWatermarkRedisMonotonicIdentityAndLegacyRecovery(t *testing.T) {
	if os.Getenv("FRESHNESS_REDIS_URL") == "" {
		t.Skip("FRESHNESS_REDIS_URL isolated Redis required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	options, err := redis.ParseURL(os.Getenv("FRESHNESS_REDIS_URL"))
	if err != nil {
		t.Fatal(err)
	}
	client := redis.NewClient(options)
	defer client.Close()
	bumper := RedisBumper{client}
	tenant := "33333333-3333-4333-8333-333333333333"
	guard := watermarkGuardKey(tenant)
	defer client.Del(ctx, guard, guard+":revision", generationKey(tenant))
	current := map[string]any{"v": 1, "tenantId": tenant, "shardIncarnation": watermarkIncarnation, "placementEpoch": "5", "sequence": "9007199254740993"}
	encoded, _ := json.Marshal(current)
	if err = client.Set(ctx, guard, encoded, time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	target := Target{Scope: scopeTenant, Tenant: tenant, Incarnation: watermarkIncarnation, PlacementEpoch: "5", Sequence: "9007199254740992"}
	if err = bumper.Advance(ctx, target); err != nil {
		t.Fatal(err)
	}
	if actual, _ := client.Get(ctx, guard).Result(); actual != string(encoded) {
		t.Fatal("BIGINT minimum regressed", actual)
	}
	target.Sequence = "9007199254740994"
	if err = bumper.Advance(ctx, target); err != nil {
		t.Fatal(err)
	}
	var row map[string]any
	actual, _ := client.Get(ctx, guard).Result()
	if err = json.Unmarshal([]byte(actual), &row); err != nil || row["sequence"] != target.Sequence {
		t.Fatal(actual, err)
	}
	target.PlacementEpoch = "4"
	target.Sequence = "9223372036854775807"
	if err = bumper.Advance(ctx, target); err != nil {
		t.Fatal(err)
	}
	if after, _ := client.Get(ctx, guard).Result(); after != actual {
		t.Fatal("old epoch changed current guard")
	}
	target.PlacementEpoch = "5"
	if err = bumper.BumpTarget(ctx, target, 1, time.Minute); err != nil {
		t.Fatal(err)
	}
	if after, _ := client.Get(ctx, guard).Result(); after != actual {
		t.Fatal("watermarked bump destroyed guard")
	}
	if err = bumper.Bump(ctx, generationKey(tenant), 2, time.Minute); err != nil {
		t.Fatal(err)
	}
	if client.Exists(ctx, guard).Val() != 0 {
		t.Fatal("legacy invalidation retained uncertified guard")
	}
	if err = bumper.Advance(ctx, target); err != nil {
		t.Fatal(err)
	}
	if client.Exists(ctx, guard).Val() != 0 {
		t.Fatal("notification manufactured missing placement guard")
	}
}
