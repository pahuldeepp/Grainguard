package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
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
	if err := common.RequireShardRegistry(os.Getenv); err != nil {
		return err
	}
	url := os.Getenv("HARDWARE_DATABASE_URL")
	if url == "" && os.Getenv("SHARD_REGISTRY_FILE") == "" {
		return errors.New("HARDWARE_DATABASE_URL required")
	}
	brokers := strings.Split(os.Getenv("KAFKA_BROKERS"), ",")
	if os.Getenv("KAFKA_BROKERS") == "" {
		return errors.New("KAFKA_BROKERS required")
	}
	mqttURL := os.Getenv("MQTT_BROKER_URL")
	if mqttURL == "" {
		return errors.New("MQTT_BROKER_URL required for physical sensor configuration")
	}
	clientID := strings.TrimSpace(os.Getenv("MQTT_CLIENT_ID"))
	if clientID == "" {
		return errors.New("MQTT_CLIENT_ID required for persistent broker sessions")
	}
	mqttTLS, err := mqttTLSConfig(mqttURL, strings.TrimSpace(os.Getenv("MQTT_CA_FILE")))
	if err != nil {
		return err
	}
	var db common.TxStarter
	var ping func(context.Context) error
	if os.Getenv("SHARD_REGISTRY_FILE") != "" {
		shards, err := common.ShardedDBFromEnvironment(os.Getenv, "hardware-service", "greenguard_hardware", "hardware_app")
		if err != nil {
			return err
		}
		defer shards.Close()
		db, ping = shards, shards.Ping
	} else {
		pool, err := pgxpool.New(ctx, url)
		if err != nil {
			return err
		}
		defer pool.Close()
		db, ping = pool, pool.Ping
	}
	startupCtx, cancelStartup := context.WithTimeout(ctx, 5*time.Second)
	defer cancelStartup()
	if err := ping(startupCtx); err != nil {
		return fmt.Errorf("connect hardware database: %w", err)
	}
	var readiness workerReadiness
	group := strings.TrimSpace(os.Getenv("HARDWARE_KAFKA_GROUP"))
	if group == "" {
		group = hardware.ConsumerGroup
	}
	client, err := hardware.KafkaClientForGroupWithReadiness(brokers, group, readiness.consumerAssigned.Store)
	if err != nil {
		return err
	}
	defer client.CloseAllowingRebalance()
	startupKafkaCtx, cancelKafkaPing := context.WithTimeout(ctx, 5*time.Second)
	err = client.Ping(startupKafkaCtx)
	cancelKafkaPing()
	if err != nil {
		return fmt.Errorf("connect hardware Kafka: %w", err)
	}
	store := hardware.Store{DB: db}
	dispatcher := hardware.MQTTDispatcher{Store: store}
	runtimeCtx, cancelRuntime := context.WithCancel(ctx)
	opts := mqtt.NewClientOptions().AddBroker(mqttURL).SetClientID(clientID)
	if mqttTLS != nil {
		opts.SetTLSConfig(mqttTLS)
	}
	opts.SetAutoReconnect(false).SetConnectRetry(false).SetCleanSession(false)
	// Serialize acknowledgements and let QoS 1 redeliver if the database write fails.
	opts.SetOrderMatters(true).SetAutoAckDisabled(true)
	if user := os.Getenv("MQTT_USERNAME"); user != "" {
		opts.SetUsername(user)
		opts.SetPassword(os.Getenv("MQTT_PASSWORD"))
	}
	var ackSubscriptionMu sync.Mutex
	ackSubscriptionRunning := false
	ackResubscribePending := false
	ackSubscriptionReady := make(chan struct{})
	reconnectRequests := make(chan struct{}, 1)
	var ackReadyOnce sync.Once
	requestReconnect := func() {
		select {
		case reconnectRequests <- struct{}{}:
		default:
		}
	}
	opts.SetConnectionLostHandler(func(_ mqtt.Client, err error) {
		readiness.ackSubscribed.Store(false)
		log.Printf("MQTT connection lost; reconnecting: %v", err)
		requestReconnect()
	})
	opts.SetOnConnectHandler(func(mc mqtt.Client) {
		readiness.ackSubscribed.Store(false)
		ackSubscriptionMu.Lock()
		if ackSubscriptionRunning {
			ackResubscribePending = true
			ackSubscriptionMu.Unlock()
			return
		}
		ackSubscriptionRunning = true
		ackSubscriptionMu.Unlock()
		go func() {
			for runtimeCtx.Err() == nil {
				subscribeAckUntilReady(runtimeCtx, mc.IsConnected, func() mqtt.Token {
					return mc.Subscribe("greenguard/+/+/ack", 1, func(_ mqtt.Client, m mqtt.Message) {
						ackCtx, cancelAck := context.WithTimeout(runtimeCtx, 10*time.Second)
						defer cancelAck()
						if _, err := dispatcher.HandleAck(ackCtx, m.Topic(), m.Payload()); err != nil {
							if errors.Is(err, hardware.ErrPermanentMQTTAck) {
								log.Printf("permanent device acknowledgement rejected; message discarded")
								m.Ack()
								return
							}
							if runtimeCtx.Err() != nil {
								return
							}
							log.Printf("transient MQTT acknowledgement failure; reconnecting for redelivery: %v", err)
							requestReconnect()
							return
						}
						m.Ack()
					})
				}, 5*time.Second, 250*time.Millisecond, mqttSubscriptionTokenGranted, func() {
					readiness.ackSubscribed.Store(true)
					ackReadyOnce.Do(func() { close(ackSubscriptionReady) })
				}, func(err error) {
					log.Printf("MQTT ack subscription failed; retrying: %v", err)
				})
				ackSubscriptionMu.Lock()
				if ackResubscribePending && runtimeCtx.Err() == nil {
					ackResubscribePending = false
					ackSubscriptionMu.Unlock()
					continue
				}
				ackResubscribePending = false
				ackSubscriptionRunning = false
				ackSubscriptionMu.Unlock()
				return
			}
		}()
	})
	mqttClient := mqtt.NewClient(opts)
	readiness.mqttConnected = mqttClient.IsConnected
	dispatcher.Client = mqttClient
	connectionDone := make(chan struct{})
	go func() {
		defer close(connectionDone)
		maintainMQTTConnection(runtimeCtx, mqttClient, reconnectRequests, func(err error) {
			log.Printf("MQTT connection attempt failed; retrying: %v", err)
		})
	}()
	defer func() {
		cancelRuntime()
		<-connectionDone
		mqttClient.Disconnect(250)
	}()
	select {
	case <-ackSubscriptionReady:
	case <-ctx.Done():
		return nil
	}
	return common.RunHTTP(ctx, os.Getenv, ":8080", common.HealthHandler(readiness.ready, func(ctx context.Context) error {
		return errors.Join(ping(ctx), client.Ping(ctx))
	}, nil), net.Listen, func(ctx context.Context, server *http.Server, listener net.Listener) error {
		return common.ServeWorker(ctx, server, listener, func(ctx context.Context) error {
			readiness.serving.Store(true)
			return runWorkers(ctx,
				readiness.runWorker(dispatcher.Run),
				readiness.runWorker((hardware.OutboxPublisher{Store: store, Client: client}).Run),
				readiness.runWorker((hardware.Worker{Store: store, Client: client}).Run),
			)
		}, func() { readiness.serving.Store(false) }, nil, 5*time.Second)
	})
}
