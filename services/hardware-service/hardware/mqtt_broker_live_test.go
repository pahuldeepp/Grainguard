package hardware

import (
	"bytes"
	"context"
	"encoding/json"
	mqtt "github.com/eclipse/paho.mqtt.golang"
	"os"
	"testing"
	"time"
)

func TestLiveMQTTConfigureAckReplay(t *testing.T) {
	broker := os.Getenv("MQTT_TEST_BROKER_URL")
	if broker == "" {
		t.Skip("MQTT_TEST_BROKER_URL required")
	}
	p := pool(t)
	s := Store{DB: p}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tenant, asset, device, saga := uuid(t), uuid(t), uuid(t), uuid(t)
	register(t, p, tenant, asset)
	c, pending := reservePendingConfigure(ctx, t, s, tenant, asset, device, saga)
	var err error
	client := mqtt.NewClient(mqtt.NewClientOptions().AddBroker(broker).SetClientID("hardware-live-" + uuid(t)))
	if token := client.Connect(); !token.WaitTimeout(5*time.Second) || token.Error() != nil {
		t.Fatalf("connect: %v", token.Error())
	}
	defer client.Disconnect(100)
	commands := make(chan ConfigureMessage, 2)
	token := client.Subscribe(commandTopic(c), 1, func(_ mqtt.Client, m mqtt.Message) {
		var msg ConfigureMessage
		if json.Unmarshal(m.Payload(), &msg) == nil {
			commands <- msg
		}
	})
	if !token.WaitTimeout(5*time.Second) || token.Error() != nil {
		t.Fatalf("subscribe: %v", token.Error())
	}
	d := MQTTDispatcher{Store: s, Client: client}
	if err = d.PublishPending(ctx); err != nil {
		t.Fatal(err)
	}
	var published ConfigureMessage
	select {
	case published = <-commands:
	case <-ctx.Done():
		t.Fatal("MQTT command not delivered")
	}
	if published.CommandID != c.CommandID || published.Status != "configure" || !published.Verify(bytes.Repeat([]byte{0x42}, 32)) {
		t.Fatalf("bad MQTT command %+v", published)
	}
	payload := signedAck(c)
	result, err := d.HandleAck(ctx, ackTopic(c), payload)
	if err != nil || result.ResultID != pending.ResultID || result.Outcome != "succeeded" {
		t.Fatalf("ack %+v %v", result, err)
	}
	if err = d.PublishPending(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-commands:
		t.Fatal("finalized command was republished")
	case <-time.After(200 * time.Millisecond):
	}
	if !resultPending(ctx, t, s, result.ResultID) {
		t.Fatal("ack result missing from durable Kafka outbox")
	}
}

func resultPending(ctx context.Context, t *testing.T, s Store, resultID string) bool {
	t.Helper()
	results, err := s.UnpublishedResults(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range results {
		if r.ResultID == resultID {
			return true
		}
	}
	return false
}
