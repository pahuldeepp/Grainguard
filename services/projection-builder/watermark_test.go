package main

import (
	"testing"

	common "greenguard.local/go-common"
)

func TestProjectionNotificationWatermarkSchemaAllowsLegacyAndRequiresTrio(t *testing.T) {
	schemas, err := common.CompileSchemas("../../contracts/events", map[string]string{"notification": "projection-notification.v1.schema.json"})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		fields map[string]any
		valid  bool
	}{
		{"legacy", nil, true},
		{"only sequence", map[string]any{"projection_sequence": "1"}, false},
		{"only identity", map[string]any{"shard_incarnation": testTenant, "placement_epoch": "0"}, false},
		{"exact decimal strings", map[string]any{"shard_incarnation": testTenant, "placement_epoch": "9007199254740993", "projection_sequence": "9223372036854775807"}, true},
		{"numeric sequence", map[string]any{"shard_incarnation": testTenant, "placement_epoch": "0", "projection_sequence": 1}, false},
		{"noncanonical decimal", map[string]any{"shard_incarnation": testTenant, "placement_epoch": "01", "projection_sequence": "1"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := validEvent(t)
			e[fieldType], e[fieldAggregateType] = "projection.notification", "projection_notification"
			payload := map[string]any{"notification_id": testTenant, "resource_type": "device", "resource_id": testTenant,
				"purpose": "projection_changed", "scope": "device", "source_event_id": testTenant,
				"source_event_type": "telemetry.recorded", "source_version": "42", "projected_at": "2026-09-27T00:00:00Z"}
			for key, value := range tc.fields {
				payload[key] = value
			}
			e[fieldPayload] = payload
			if err := schemas["notification"].Validate(e); (err == nil) != tc.valid {
				t.Fatal("unexpected notification contract validation", err)
			}
		})
	}
}
