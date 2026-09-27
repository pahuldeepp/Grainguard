// mqtt-fixture is an opt-in local device simulator for Stage 07 integration.
// It must never be deployed or used as production firmware.
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"greenguard.local/hardware-service/hardware"
)

const topicPrefix = "greenguard/"

type fixture struct {
	TenantID  string `json:"tenant_id"`
	AssetID   string `json:"asset_id"`
	SecretHex string `json:"secret_hex"`
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}
func run(ctx context.Context) error {
	broker := os.Getenv("MQTT_BROKER_URL")
	file := os.Getenv("MQTT_FIXTURES_FILE")
	if broker == "" || file == "" {
		return errors.New("MQTT_BROKER_URL and MQTT_FIXTURES_FILE required")
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	var fixtures []fixture
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		return err
	}
	keys, err := fixtureKeys(fixtures)
	if err != nil {
		return err
	}
	opts := mqtt.NewClientOptions().AddBroker(broker).SetClientID("greenguard-mqtt-fixture-" + os.Getenv("HOSTNAME"))
	opts.SetAutoReconnect(true)
	opts.SetOnConnectHandler(func(c mqtt.Client) { subscribeFixtures(c, fixtures, keys) })
	client := mqtt.NewClient(opts)
	token := client.Connect()
	if !token.WaitTimeout(10 * time.Second) {
		return fmt.Errorf("MQTT connect timeout")
	}
	if err = token.Error(); err != nil {
		return err
	}
	defer client.Disconnect(100)
	<-ctx.Done()
	return nil
}

// fixtureKeys decodes each fixture's ack secret, keyed by tenant:asset.
func fixtureKeys(fixtures []fixture) (map[string][]byte, error) {
	keys := map[string][]byte{}
	for _, f := range fixtures {
		key, err := hex.DecodeString(f.SecretHex)
		if err != nil || len(key) < 32 {
			return nil, errors.New("fixture secret invalid")
		}
		keys[f.TenantID+":"+f.AssetID] = key
	}
	if len(keys) == 0 {
		return nil, errors.New("no device fixtures")
	}
	return keys, nil
}

func subscribeFixtures(c mqtt.Client, fixtures []fixture, keys map[string][]byte) {
	handler := func(client mqtt.Client, m mqtt.Message) { answerConfigure(client, m, keys) }
	for _, f := range fixtures {
		topic := topicPrefix + f.TenantID + "/" + f.AssetID + "/command"
		token := c.Subscribe(topic, 1, handler)
		if !token.WaitTimeout(5*time.Second) || token.Error() != nil {
			log.Printf("device fixture subscribe failed: %v", token.Error())
		}
	}
}

// answerConfigure acknowledges a verified configure command, ignoring anything else.
func answerConfigure(client mqtt.Client, m mqtt.Message, keys map[string][]byte) {
	var command hardware.ConfigureMessage
	if json.Unmarshal(m.Payload(), &command) != nil {
		return
	}
	key := keys[command.TenantID+":"+command.AssetID]
	if key == nil || command.Status != "configure" || !command.Verify(key) {
		return
	}
	ack := command
	ack.Status = "configured"
	ack.Sign(key)
	data, _ := json.Marshal(ack)
	client.Publish(topicPrefix+ack.TenantID+"/"+ack.AssetID+"/ack", 1, false, data)
}
