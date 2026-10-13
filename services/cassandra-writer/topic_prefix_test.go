package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTopicPrefixValidation(t *testing.T) {
	for _, prefix := range []string{"", "provisioning-demo."} {
		if err := validateTopicPrefix(prefix); err != nil {
			t.Fatal(err)
		}
	}
	for _, prefix := range []string{"bad space", "é", strings.Repeat("x", 249)} {
		if validateTopicPrefix(prefix) == nil {
			t.Fatal("accepted invalid prefix")
		}
	}
}
func TestHistoryQuarantinePreservesTransportIdentity(t *testing.T) {
	m := Message{Topic: topicTelemetry, TransportTopic: "provisioning-demo." + topicTelemetry, Partition: 2, Offset: 4, Value: []byte("null")}
	record, err := quarantine(m, "bad_event")
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err = json.Unmarshal(record.Value, &body); err != nil {
		t.Fatal(err)
	}
	if body["source_topic"] != m.TransportTopic || !strings.Contains(string(record.Key), m.TransportTopic) {
		t.Fatal("lost transport provenance")
	}
	if transportTopic(Message{Topic: topicTelemetry}) != topicTelemetry {
		t.Fatal("default transport changed")
	}
}
