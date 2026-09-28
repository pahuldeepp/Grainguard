package main

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

func TestRunRequiresDatabaseAndBroker(t *testing.T) {
	t.Setenv("HARDWARE_DATABASE_URL", "")
	t.Setenv("KAFKA_BROKERS", "")
	t.Setenv("MQTT_BROKER_URL", "")
	t.Setenv("MQTT_CLIENT_ID", "")
	if err := run(context.Background()); err == nil {
		t.Fatal("missing database accepted")
	}
	t.Setenv("HARDWARE_DATABASE_URL", "postgresql://localhost/test")
	if err := run(context.Background()); err == nil {
		t.Fatal("missing broker accepted")
	}
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	if err := run(context.Background()); err == nil || !strings.Contains(err.Error(), "MQTT_BROKER_URL") {
		t.Fatalf("missing MQTT broker error = %v", err)
	}
	t.Setenv("MQTT_BROKER_URL", "tcp://localhost:1883")
	if err := run(context.Background()); err == nil || !strings.Contains(err.Error(), "MQTT_CLIENT_ID") {
		t.Fatalf("missing persistent client ID error = %v", err)
	}
}

func TestRunReturnsEarlyWhenContextIsAlreadyCanceled(t *testing.T) {
	t.Setenv("HARDWARE_DATABASE_URL", "postgresql://localhost/test")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := run(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
}

func TestRunWorkersWaitsForShutdownBeforeReturning(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	finished := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- runWorkers(ctx, func(ctx context.Context) error {
			close(started)
			<-ctx.Done()
			close(finished)
			return nil
		})
	}()
	<-started
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runWorkers: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("runWorkers did not wait for worker shutdown")
	}
	select {
	case <-finished:
	default:
		t.Fatal("runWorkers returned before worker cleanup")
	}
}

type fakeConnectionClient struct {
	mqtt.Client
	connected atomic.Bool
	connects  atomic.Int32
}

func (c *fakeConnectionClient) Connect() mqtt.Token {
	c.connects.Add(1)
	c.connected.Store(true)
	return completedMQTTToken(nil)
}

func (c *fakeConnectionClient) IsConnected() bool { return c.connected.Load() }

func (c *fakeConnectionClient) Disconnect(uint) { c.connected.Store(false) }

func TestMaintainMQTTConnectionReconnectsOnRequestAndStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := &fakeConnectionClient{}
	reconnect := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() {
		maintainMQTTConnection(ctx, client, reconnect, nil)
		close(done)
	}()
	deadline := time.Now().Add(time.Second)
	for client.connects.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if client.connects.Load() != 1 {
		t.Fatal("initial MQTT connection was not attempted")
	}
	reconnect <- struct{}{}
	time.Sleep(50 * time.Millisecond)
	if got := client.connects.Load(); got != 1 {
		t.Fatalf("requested reconnect bypassed backoff: connects = %d", got)
	}
	deadline = time.Now().Add(time.Second)
	for client.connects.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if client.connects.Load() != 2 {
		t.Fatal("MQTT reconnect was not attempted")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("MQTT connection supervisor ignored cancellation")
	}
}

func TestRunWorkersCancelsSiblingsAfterError(t *testing.T) {
	want := errors.New("worker failed")
	siblingStopped := make(chan struct{})
	err := runWorkers(context.Background(),
		func(context.Context) error { return want },
		func(ctx context.Context) error {
			<-ctx.Done()
			close(siblingStopped)
			return nil
		},
	)
	if !errors.Is(err, want) {
		t.Fatalf("runWorkers error = %v; want %v", err, want)
	}
	select {
	case <-siblingStopped:
	default:
		t.Fatal("runWorkers returned before sibling stopped")
	}
}

func TestRunWorkersPreservesWorkerErrorWhenParentCancels(t *testing.T) {
	want := errors.New("worker failed during shutdown")
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- runWorkers(ctx, func(ctx context.Context) error {
			close(started)
			<-ctx.Done()
			return want
		})
	}()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, want) {
			t.Fatalf("runWorkers error = %v; want %v", err, want)
		}
	case <-time.After(time.Second):
		t.Fatal("runWorkers did not finish cancellation")
	}
}

func TestRunWorkersRejectsUnexpectedExit(t *testing.T) {
	err := runWorkers(context.Background(), func(context.Context) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "stopped unexpectedly") {
		t.Fatalf("runWorkers error = %v; want unexpected-exit error", err)
	}
}
