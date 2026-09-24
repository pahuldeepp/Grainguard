package main

import (
	"bytes"
	"testing"
)

func TestExplicitRoutingAllowlist(t *testing.T) {
	for _, tc := range []struct{ eventType, topic string }{
		{typeTelemetry, topicTelemetry}, {typeRegistered, topicInventory},
		{typeBinding, topicInventory}, {typeStatus, topicInventory},
		{typeSiteChanged, topicFacility}, {typeBinChanged, topicFacility},
		{typeLotChanged, topicLot},
		{typeRiskAssessed, topicRisk}, {typeRiskInvalidated, topicRiskInvalidated},
		{typeAlertOpened, topicAlerts}, {typeAlertUpdated, topicAlerts},
		{typeAlertAcked, topicAlerts}, {typeAlertEscalated, topicAlerts}, {typeAlertResolved, topicAlerts},
	} {
		topic, err := route(map[string]any{fieldType: tc.eventType})
		requireReason(t, err, "")
		if topic != tc.topic {
			t.Fatalf("%s routed to %s", tc.eventType, topic)
		}
	}
	for _, eventType := range []any{"device.future", "lot.retired", "", nil, 3} {
		topic, err := route(map[string]any{fieldType: eventType})
		requireReason(t, err, reasonUnknown)
		if topic != "" {
			t.Fatal("unknown event received a canonical topic")
		}
	}
}

func TestRiskAndAlertCanonicalSourceIsolation(t *testing.T) {
	s := testSchemas(t)
	cases := []struct{ fixture, source, destination string }{
		{"risk-assessed.v1.valid.json", rawRisk, topicRisk},
		{"alerts/alert-opened.v1.valid.json", rawAlerts, topicAlerts},
		{"alerts/alert-acknowledged.v1.valid.json", rawAlerts, topicAlerts},
	}
	for _, tc := range cases {
		t.Run(tc.fixture, func(t *testing.T) {
			event := eventFixture(t, tc.fixture)
			message := Message{Topic: tc.source, Value: rawEvent(t, event)}
			record, ignored, err := transform(message, s)
			requireReason(t, err, "")
			if ignored != "" || record.Topic != tc.destination || string(record.Key) != event[fieldTenant].(string)+":"+event[fieldAggregate].(string) {
				t.Fatal("wrong canonical topic, tenant key, or ignored result")
			}
			for _, wrong := range []string{rawInventory, rawTelemetry, rawRisk, rawAlerts} {
				if wrong == tc.source {
					continue
				}
				message.Topic = wrong
				_, _, err := transform(message, s)
				requireReason(t, err, reasonEnvelope)
			}
		})
	}
}

func TestLotCanonicalMappingAndSourceIsolation(t *testing.T) {
	s := testSchemas(t)
	event := eventFixture(t, "lot-changed.v1.valid.json")
	record, ignored, err := transform(Message{Topic: rawInventory, Value: rawEvent(t, event)}, s)
	requireReason(t, err, "")
	if ignored != "" || record.Topic != topicLot || string(record.Key) != event[fieldTenant].(string)+":"+event[fieldAggregate].(string) {
		t.Fatal("lot event must route by tenant and bin into its dedicated topic")
	}
	_, _, err = transform(Message{Topic: rawTelemetry, Value: rawEvent(t, event)}, s)
	requireReason(t, err, reasonEnvelope)
}

func TestFacilityCanonicalMappingAndSourceIsolation(t *testing.T) {
	s := testSchemas(t)
	for _, kind := range []string{"site", "bin"} {
		event := eventFixture(t, kind+"-changed.v1.valid.json")
		message := Message{Topic: rawInventory, Value: rawEvent(t, event)}
		record, ignored, err := transform(message, s)
		requireReason(t, err, "")
		if record.Topic != topicFacility || ignored != "" || string(record.Key) != event[fieldTenant].(string)+":"+event[fieldAggregate].(string) {
			t.Fatal("incorrect facility routing or key")
		}
		for _, key := range []string{fieldEvent, fieldType, fieldTenant, fieldCorrelation, fieldTrace} {
			if record.Headers[key] != event[key] {
				t.Fatalf("lost header %s", key)
			}
		}
		if record.Headers[fieldSchema] != "1" {
			t.Fatal("lost schema version")
		}
		replay, _, err := transform(message, s)
		requireReason(t, err, "")
		if !bytes.Equal(record.Value, replay.Value) {
			t.Fatal("replay changed canonical bytes")
		}
		message.Topic = rawTelemetry
		_, _, err = transform(message, s)
		requireReason(t, err, reasonEnvelope)
	}
}
