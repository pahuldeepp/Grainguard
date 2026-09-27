package main

import "testing"

// Stage 08 (ADR-0016): committed read-model notifications route only from their raw topic.
func TestProjectionNotificationRoute(t *testing.T) {
	s := testSchemas(t)
	for _, name := range []string{"projection/projection-notification.v1.valid.json", "projection/projection-notification-tenant.v1.valid.json", "projection/projection-notification-epoch.v1.valid.json"} {
		event := eventFixture(t, name)
		record, ignored, err := transform(Message{Topic: rawProjection, Value: rawEvent(t, event)}, s)
		requireReason(t, err, "")
		if ignored != "" || record.Topic != topicProjection || string(record.Key) != event[fieldTenant].(string)+":"+event[fieldAggregate].(string) {
			t.Fatal(name, record.Topic, ignored)
		}
		for _, wrong := range []string{rawInventory, rawTelemetry, rawRisk, rawAlerts} {
			_, _, err := transform(Message{Topic: wrong, Value: rawEvent(t, event)}, s)
			requireReason(t, err, reasonEnvelope)
		}
	}
	telemetry := eventFixture(t, "telemetry-recorded.v1.valid.json")
	_, _, err := transform(Message{Topic: rawProjection, Value: rawEvent(t, telemetry)}, s)
	requireReason(t, err, reasonEnvelope)
}

func TestProjectionNotificationSemantics(t *testing.T) {
	s := testSchemas(t)
	for _, name := range []string{"source-not-causation.json", "telemetry-tenant-scope.json", "resource-differs.json", "version-differs.json"} {
		event := eventFixture(t, "projection/invalid/"+name)
		_, _, err := transform(Message{Topic: rawProjection, Value: rawEvent(t, event)}, s)
		requireReason(t, err, reasonSchema)
	}
	epoch := eventFixture(t, "projection/projection-notification-epoch.v1.valid.json")
	epoch[fieldTenant] = "11111111-1111-4111-8111-111111111111"
	_, _, err := transform(Message{Topic: rawProjection, Value: rawEvent(t, epoch)}, s)
	requireReason(t, err, reasonSchema)
}
