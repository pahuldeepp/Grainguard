package main

import "testing"

func TestWorkerReadinessRequiresConsumerAndMQTTAckSubscription(t *testing.T) {
	connected := true
	readiness := &workerReadiness{mqttConnected: func() bool { return connected }}
	if readiness.ready() {
		t.Fatal("worker became ready before startup")
	}
	readiness.serving.Store(true)
	readiness.consumerAssigned.Store(true)
	readiness.ackSubscribed.Store(true)
	for range 2 {
		readiness.workersStarted.Add(1)
	}
	if readiness.ready() {
		t.Fatal("worker became ready before every processing loop started")
	}
	readiness.workersStarted.Add(1)
	if !readiness.ready() {
		t.Fatal("worker should become ready after consumer assignment and MQTT subscription")
	}
	readiness.consumerAssigned.Store(false)
	if readiness.ready() {
		t.Fatal("revoked Kafka assignment must make worker unready")
	}
	readiness.consumerAssigned.Store(true)
	readiness.ackSubscribed.Store(false)
	if readiness.ready() {
		t.Fatal("lost MQTT acknowledgement subscription must make worker unready")
	}
	readiness.ackSubscribed.Store(true)
	connected = false
	if readiness.ready() {
		t.Fatal("disconnected MQTT broker must make worker unready")
	}
}
