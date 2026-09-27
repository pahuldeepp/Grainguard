package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestLiveHintIsScopedAndRejectsUnsafeKeys(t *testing.T) {
	for _, tc := range []struct{ key, scope, tenant, device string }{
		{deviceVersionKey("tenant-A", "sensor-A"), scopeDevice, "tenant-A", "sensor-A"},
		{generationKey("tenant-B"), scopeTenant, "tenant-B", ""},
		{epochKey, scopeEpoch, "", ""},
	} {
		value, err := liveHint(tc.key)
		if err != nil {
			t.Fatal(err)
		}
		var hint struct{ Scope, Tenant, Device string }
		if err := json.Unmarshal([]byte(value), &hint); err != nil {
			t.Fatal(err)
		}
		if hint.Scope != tc.scope || hint.Tenant != tc.tenant || hint.Device != tc.device {
			t.Fatalf("%q: %+v", tc.key, hint)
		}
	}
	for _, key := range []string{"arbitrary", generationKey("bad:tenant"), deviceVersionKey("tenant-A", "bad:device")} {
		if _, err := liveHint(key); err == nil {
			t.Fatalf("accepted %q", key)
		}
	}
}

func TestLiveRedisBumpPublishesHint(t *testing.T) {
	if os.Getenv("CACHE_INVALIDATOR_LIVE") != "1" {
		t.Skip("CACHE_INVALIDATOR_LIVE=1 required")
	}
	r, err := newRedis(os.Getenv, 250*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	feed := r.client.Subscribe(ctx, liveChannel)
	defer feed.Close()
	if _, err := feed.Receive(ctx); err != nil {
		t.Fatal(err)
	}
	key := deviceVersionKey("proof"+randomSuffix(t), "device"+randomSuffix(t))
	if err := r.Bump(ctx, key, time.Now().UnixMilli(), time.Minute); err != nil {
		t.Fatal(err)
	}
	want, _ := liveHint(key)
	select {
	case msg := <-feed.Channel():
		if msg == nil || msg.Payload != want {
			t.Fatalf("live hint: got %v, want %q", msg, want)
		}
	case <-ctx.Done():
		t.Fatal("live hint timeout", ctx.Err())
	}
}
