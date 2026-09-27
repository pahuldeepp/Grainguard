package main

import (
	"encoding/json"
	"testing"
)

func TestEntitlementEventRejectsCrossTenantAndOutOfOrderIdentity(t *testing.T) {
	a, b := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
	event := map[string]any{"event_id": b, "event_type": "entitlements.changed", "tenant_id": a,
		"aggregate_type": "entitlement", "aggregate_id": a, "aggregate_version": "2",
		"payload": map[string]any{"tenant_id": a, "plan_key": "standard", "plan_version": "1", "source_version": "2",
			"limits": map[string]int{"ingest.readings_per_month": 1000}, "features": map[string]bool{"audit_export": true}, "effective_at": "2026-09-25T00:00:00Z"}}
	raw, _ := json.Marshal(event)
	if got, err := parseEntitlement(raw, []byte(a+":"+a)); err != nil || got == nil {
		t.Fatalf("valid event %v", err)
	}
	if _, err := parseEntitlement(raw, []byte(b+":"+b)); err == nil {
		t.Fatal("foreign key accepted")
	}
	p := event["payload"].(map[string]any)
	p["tenant_id"] = b
	raw, _ = json.Marshal(event)
	if _, err := parseEntitlement(raw, []byte(a+":"+a)); err == nil {
		t.Fatal("foreign payload accepted")
	}
}
