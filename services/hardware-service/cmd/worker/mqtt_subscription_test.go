package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

type staticMQTTToken struct {
	done chan struct{}
	err  error
}

func completedMQTTToken(err error) mqtt.Token {
	done := make(chan struct{})
	close(done)
	return staticMQTTToken{done: done, err: err}
}

func (t staticMQTTToken) Wait() bool {
	<-t.done
	return true
}

func (t staticMQTTToken) WaitTimeout(timeout time.Duration) bool {
	select {
	case <-t.done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (t staticMQTTToken) Done() <-chan struct{} { return t.done }
func (t staticMQTTToken) Error() error          { return t.err }

func TestSubscribeAckRetriesUntilSubscriptionSucceeds(t *testing.T) {
	var attempts atomic.Int32
	subscribeAckUntilReady(
		context.Background(),
		func() bool { return true },
		func() mqtt.Token {
			if attempts.Add(1) == 1 {
				return completedMQTTToken(errors.New("broker rejected subscription"))
			}
			return completedMQTTToken(nil)
		},
		time.Second,
		time.Millisecond,
		func(mqtt.Token) bool { return true },
		nil,
		nil,
	)
	if got := attempts.Load(); got != 2 {
		t.Fatalf("subscription attempts = %d; want 2", got)
	}
}

func TestSubscribeAckWaitsForConnectionAndStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var attempts atomic.Int32
	time.AfterFunc(10*time.Millisecond, cancel)
	subscribeAckUntilReady(
		ctx,
		func() bool { return false },
		func() mqtt.Token {
			attempts.Add(1)
			return completedMQTTToken(nil)
		},
		time.Second,
		time.Millisecond,
		func(mqtt.Token) bool { return true },
		nil,
		nil,
	)
	if got := attempts.Load(); got != 0 {
		t.Fatalf("subscription attempted while disconnected %d times", got)
	}
}

func TestMQTTSubscriptionGrantedChecksBrokerRefusals(t *testing.T) {
	if !mqttSubscriptionGranted(map[string]byte{"greenguard/+/+/ack": 1}) {
		t.Fatal("accepted QoS 1 subscription was rejected")
	}
	if mqttSubscriptionGranted(map[string]byte{"greenguard/+/+/ack": 0x80}) {
		t.Fatal("broker refusal was accepted")
	}
	if mqttSubscriptionGranted(nil) {
		t.Fatal("empty SUBACK result was accepted")
	}
}
