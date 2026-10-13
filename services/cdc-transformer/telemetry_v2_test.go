package main

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestTelemetryV2FixtureParityAndSourceRouting(t *testing.T) {
	schemas := testSchemas(t)
	var cases map[string]bool
	if err := json.Unmarshal(read(t, filepath.Join(fixtureRoot, "telemetry-v2.expectations.json")), &cases); err != nil {
		t.Fatal(err)
	}
	for name, want := range cases {
		event := eventFixture(t, name)
		if got := schemas.Validate(event) == nil; got != want {
			t.Errorf("%s accepted=%v want=%v", name, got, want)
		}
	}
	event := eventFixture(t, "telemetry-recorded.v2.valid.json")
	record, ignored, err := transform(Message{Topic: rawTelemetry, Value: rawEvent(t, event)}, schemas)
	if err != nil || ignored != "" || record.Topic != topicTelemetryV2 {
		t.Fatalf("v2 route %s %s %v", record.Topic, ignored, err)
	}
	for _, op := range []string{"c", "r"} {
		raw := read(t, filepath.Join(fixtureRoot, "raw/telemetry-v2.json"))
		raw = bytes.Replace(raw, []byte(`"op": "c"`), []byte(`"op": "`+op+`"`), 1)
		replay, _, failure := transform(Message{Topic: rawTelemetry, Value: raw}, schemas)
		if failure != nil || !bytes.Equal(record.Value, replay.Value) || !bytes.Equal(record.Key, replay.Key) {
			t.Fatalf("snapshot identity/bytes changed: %v", failure)
		}
	}
	_, _, err = transform(Message{Topic: rawInventory, Value: rawEvent(t, event)}, schemas)
	requireReason(t, err, reasonEnvelope)
	layout := eventFixture(t, "cable-layout-changed.v1.valid.json")
	record, _, err = transform(Message{Topic: rawInventory, Value: rawEvent(t, layout)}, schemas)
	if err != nil || record.Topic != topicSensorLayout {
		t.Fatalf("layout route=%s error=%v", record.Topic, err)
	}
}
