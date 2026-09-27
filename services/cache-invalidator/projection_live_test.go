package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	redislib "github.com/redis/go-redis/v9"
)

// Consumes the canonical result of a committed projection notification. The
// unique consumer group leaves production offsets untouched.
func TestLiveConsumeProjectionNotification(t *testing.T) {
	if os.Getenv("CACHE_PROJECTION_LIVE") != "1" {
		t.Skip("CACHE_PROJECTION_LIVE=1 required")
	}
	match := os.Getenv("CACHE_PROJECTION_EVENT_ID")
	if match == "" {
		t.Fatal("CACHE_PROJECTION_EVENT_ID required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	r, err := newRedis(os.Getenv, 250*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	source, err := newKafka(brokers(os.Getenv), "cache-projection-proof-"+match)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	var matched *Record
	for matched == nil && ctx.Err() == nil {
		pollCtx, stop := context.WithTimeout(ctx, time.Second)
		records, err := source.Poll(pollCtx, 100)
		stop()
		if err != nil {
			t.Fatal(err)
		}
		for _, record := range records {
			var event struct {
				CausationID string `json:"causation_id"`
			}
			if json.Unmarshal(record.Value, &event) == nil && event.CausationID == match {
				matched = &record
				break
			}
		}
		source.AllowRebalance()
	}
	if matched == nil {
		t.Fatal("canonical projection notification not observed")
	}
	target, err := parseTarget(matched.Value)
	if err != nil {
		t.Fatal(err)
	}
	key := target.Key()
	before, err := r.client.Get(ctx, key).Result()
	if err != nil && err != redislib.Nil {
		t.Fatal(err)
	}
	b := newBatch()
	b.add(*matched)
	w := testWorker(&fakeSource{}, &fakeBumper{})
	w.Source = source
	w.Bumper = r
	if err := w.flush(ctx, b); err != nil {
		t.Fatal(err)
	}
	after, err := r.client.Get(ctx, key).Result()
	if err != nil || after == before || after == "" {
		t.Fatalf("cache stamp did not advance: before=%q after=%q err=%v", before, after, err)
	}
	t.Logf("canonical event %s committed after %s advanced %q -> %q", match, key, before, after)
}
