package hardware

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
)

func TestLiveConfigureNeedsAuthenticatedMatchingAck(t *testing.T) {
	p := pool(t)
	s := Store{DB: p}
	ctx := context.Background()
	tenant, asset, device, saga := uuid(t), uuid(t), uuid(t), uuid(t)
	register(t, p, tenant, asset)
	configure, pending := reservePendingConfigure(ctx, t, s, tenant, asset, device, saga)
	dispatcher := MQTTDispatcher{Store: s}
	secret := bytes.Repeat([]byte{0x42}, 32)
	ack := messageFor(configure, "configured")
	ack.Sign(secret)
	for _, change := range []func(*ConfigureMessage){
		func(m *ConfigureMessage) { m.MAC = "00" },
		func(m *ConfigureMessage) { m.CommandID = uuid(t); m.Sign(secret) },
		func(m *ConfigureMessage) { m.TenantID = uuid(t); m.Sign(secret) },
		func(m *ConfigureMessage) { m.FencingToken++; m.Sign(secret) },
	} {
		invalid := ack
		change(&invalid)
		data, _ := json.Marshal(invalid)
		if _, err := dispatcher.HandleAck(ctx, ackTopic(configure), data); err == nil {
			t.Fatal("invalid ack accepted")
		}
		applyExpect(ctx, t, s, configure, "pending", "invalid ack changed state")
	}
	data, _ := json.Marshal(ack)
	result, err := dispatcher.HandleAck(ctx, ackTopic(configure), data)
	if err != nil || result.Outcome != "succeeded" || result.ResultID != pending.ResultID {
		t.Fatalf("valid ack %+v %v", result, err)
	}
	// Simulate the MQTT worker dying after committing the ack and before Kafka publish.
	recovered := Store{DB: p}
	if !drainUntilPublished(ctx, t, recovered, result.ResultID) {
		t.Fatal("ack result not recovered from durable outbox")
	}
	assertNotPending(ctx, t, recovered, result.ResultID)
	again, err := s.Apply(ctx, configure)
	if err != nil || again.ResultID != result.ResultID || again.Outcome != "succeeded" {
		t.Fatalf("replay %+v %v", again, err)
	}
}

// drainUntilPublished drains the shared ordered outbox in bounded passes.
func drainUntilPublished(ctx context.Context, t *testing.T, store Store, resultID string) bool {
	t.Helper()
	broker := &fakeKafka{}
	for pass := 0; pass < 20; pass++ {
		if err := (OutboxPublisher{Store: store, Client: broker}).PublishPending(ctx); err != nil {
			t.Fatal(err)
		}
		if publishedResult(broker, resultID) {
			return true
		}
	}
	return false
}

func publishedResult(broker *fakeKafka, resultID string) bool {
	for _, record := range broker.published {
		var out Result
		if json.Unmarshal(record.Value, &out) == nil && out.ResultID == resultID {
			return true
		}
	}
	return false
}

func assertNotPending(ctx context.Context, t *testing.T, store Store, resultID string) {
	t.Helper()
	remaining, err := store.UnpublishedResults(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, out := range remaining {
		if out.ResultID == resultID {
			t.Fatal("published result remained pending")
		}
	}
}
