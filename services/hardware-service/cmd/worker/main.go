package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"strings"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	"greenguard.local/hardware-service/hardware"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	if ctx.Err() != nil {
		return nil
	}
	url := os.Getenv("HARDWARE_DATABASE_URL")
	if url == "" {
		return errors.New("HARDWARE_DATABASE_URL required")
	}
	brokers := strings.Split(os.Getenv("KAFKA_BROKERS"), ",")
	if os.Getenv("KAFKA_BROKERS") == "" {
		return errors.New("KAFKA_BROKERS required")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()
	client, err := hardware.KafkaClient(brokers)
	if err != nil {
		return err
	}
	defer client.CloseAllowingRebalance()
	store := hardware.Store{DB: pool}
	mqttURL := os.Getenv("MQTT_BROKER_URL")
	if mqttURL == "" {
		return errors.New("MQTT_BROKER_URL required for physical sensor configuration")
	}
	dispatcher := hardware.MQTTDispatcher{Store: store}
	opts := mqtt.NewClientOptions().AddBroker(mqttURL).SetClientID("greenguard-hardware-" + os.Getenv("HOSTNAME"))
	opts.SetAutoReconnect(true).SetConnectRetry(true).SetOrderMatters(false)
	if user := os.Getenv("MQTT_USERNAME"); user != "" {
		opts.SetUsername(user)
		opts.SetPassword(os.Getenv("MQTT_PASSWORD"))
	}
	opts.SetOnConnectHandler(func(mc mqtt.Client) {
		token := mc.Subscribe("greenguard/+/+/ack", 1, func(_ mqtt.Client, m mqtt.Message) {
			if _, err := dispatcher.HandleAck(ctx, m.Topic(), m.Payload()); err != nil {
				log.Printf("MQTT acknowledgement ignored: %v", err)
			}
		})
		if !token.WaitTimeout(5*time.Second) || token.Error() != nil {
			log.Print("MQTT ack subscription failed; reconnecting")
		}
	})
	mqttClient := mqtt.NewClient(opts)
	token := mqttClient.Connect()
	if !token.WaitTimeout(10 * time.Second) {
		return errors.New("MQTT connect timed out")
	}
	if err := token.Error(); err != nil {
		return err
	}
	defer mqttClient.Disconnect(250)
	dispatcher.Client = mqttClient
	errorsCh := make(chan error, 3)
	go func() { errorsCh <- dispatcher.Run(ctx) }()
	go func() { errorsCh <- (hardware.OutboxPublisher{Store: store, Client: client}).Run(ctx) }()
	go func() { errorsCh <- (hardware.Worker{Store: store, Client: client}).Run(ctx) }()
	select {
	case <-ctx.Done():
		return nil
	case err := <-errorsCh:
		return err
	}
}
