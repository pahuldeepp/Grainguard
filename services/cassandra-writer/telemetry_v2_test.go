package main

import (
	"encoding/json"
	"github.com/twmb/franz-go/pkg/kgo"
	"os"
	"testing"
)

func TestWriterV2FixtureParityAndVersionTopicAgreement(t *testing.T) {
	schema, err := loadSchema("../../contracts/events")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../tests/fixtures/events/telemetry-v2.expectations.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases map[string]bool
	_ = json.Unmarshal(raw, &cases)
	for name, want := range cases {
		raw, err := os.ReadFile("../../tests/fixtures/events/" + name)
		if err != nil {
			t.Fatal(err)
		}
		event, ok := decode(raw)
		if !ok {
			t.Fatal(name)
		}
		if got := schema.Validate(event) == nil; got != want {
			t.Errorf("%s accepted=%v want=%v", name, got, want)
		}
	}
	raw, _ = os.ReadFile("../../tests/fixtures/events/telemetry-recorded.v2.valid.json")
	m := Message{Topic: topicTelemetryV2, Key: []byte("11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333"), Value: raw, Headers: []kgo.RecordHeader{{Key: fieldEvent, Value: []byte("0d72ff07-a646-4d41-9b5b-52c5f25e4ca8")}, {Key: fieldType, Value: []byte(typeTelemetry)}, {Key: fieldSchema, Value: []byte("2")}, {Key: fieldTenant, Value: []byte("11111111-1111-4111-8111-111111111111")}}}
	r, _, reason := parse(schema, m)
	if reason != "" || r.SchemaVersion != 2 || r.CO2PPM == nil || r.GrainMoisturePercent == nil || r.SensorObservations == "" {
		t.Fatalf("v2 reading %+v %s", r, reason)
	}
	m.Topic = topicTelemetry
	if _, _, reason := parse(schema, m); reason != reasonKey {
		t.Fatal("v2 accepted on v1 topic")
	}
}
