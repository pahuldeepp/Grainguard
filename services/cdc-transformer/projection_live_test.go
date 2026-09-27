package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// Opt-in isolated CDC transformer proof. The unique group consumes only the
// projection raw topic and publishes only the requested event, so other domain
// streams and existing consumer offsets are untouched.
func TestLiveTransformProjectionNotification(t *testing.T) {
	if os.Getenv("PROJECTION_NOTIFICATION_LIVE") != "1" {
		t.Skip("PROJECTION_NOTIFICATION_LIVE=1 required")
	}
	eventID := os.Getenv("PROJECTION_NOTIFICATION_EVENT_ID")
	broker := os.Getenv("KAFKA_BROKERS")
	if eventID == "" || broker == "" {
		t.Fatal("event ID and broker required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := kgo.NewClient(kgo.SeedBrokers(strings.Split(broker, ",")...), kgo.ConsumerGroup("projection-notification-proof-"+eventID),
		kgo.ConsumeTopics(rawProjection), kgo.ConsumeStartOffset(kgo.NewOffset().AtStart()), kgo.DisableAutoCommit())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	raw := awaitRawProjectionNotification(ctx, t, client, eventID)
	if raw == nil {
		t.Fatal("CDC raw projection notification not observed")
	}
	result, ignored, failure := transform(Message{Topic: rawProjection, Value: raw}, testSchemas(t))
	if failure != nil || ignored != "" || result.Topic != topicProjection {
		t.Fatalf("transform: topic=%q want=%q ignored=%q err=%v", result.Topic, topicProjection, ignored, failure)
	}
	var headers []kgo.RecordHeader
	for key, value := range result.Headers {
		headers = append(headers, kgo.RecordHeader{Key: key, Value: []byte(value)})
	}
	produced := client.ProduceSync(ctx, &kgo.Record{Topic: result.Topic, Key: result.Key, Value: result.Value, Headers: headers})
	if err := produced.FirstErr(); err != nil {
		t.Fatal(err)
	}
	t.Logf("transformed raw event %s to canonical topic %s", eventID, result.Topic)
}

// awaitRawProjectionNotification polls until the raw CDC record for eventID arrives or ctx ends.
func awaitRawProjectionNotification(ctx context.Context, t *testing.T, client *kgo.Client, eventID string) []byte {
	t.Helper()
	for ctx.Err() == nil {
		fetches := client.PollRecords(ctx, 100)
		if errs := fetches.Errors(); len(errs) > 0 {
			t.Fatal(errs)
		}
		raw := findProjectionNotification(fetches.Records(), eventID)
		client.AllowRebalance()
		if raw != nil {
			return raw
		}
	}
	return nil
}

func findProjectionNotification(records []*kgo.Record, eventID string) []byte {
	for _, record := range records {
		row, ignored, invalid := unwrap(record.Value)
		if invalid == nil && ignored == "" && row[fieldEvent] == eventID {
			return record.Value
		}
	}
	return nil
}

func TestFindProjectionNotificationMatchesOutboxEventID(t *testing.T) {
	event := eventFixture(t, "projection/projection-notification.v1.valid.json")
	eventID := event[fieldEvent].(string)
	direct, _ := json.Marshal(map[string]any{"op": "c", "source": map[string]any{"table": "outbox_events"}, "after": event})
	wrapped := rawEvent(t, event)
	other := eventFixture(t, "projection/projection-notification-tenant.v1.valid.json")
	for _, raw := range [][]byte{direct, wrapped} {
		records := []*kgo.Record{{Value: rawEvent(t, other)}, {Value: raw}}
		if got := findProjectionNotification(records, eventID); string(got) != string(raw) {
			t.Fatal("did not select matching outbox event ID")
		}
	}
	if got := findProjectionNotification([]*kgo.Record{{Value: []byte("bad json")}}, eventID); got != nil {
		t.Fatal("malformed record matched")
	}
}
