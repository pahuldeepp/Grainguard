package main

import (
	"encoding/json"
	"testing"
)

func TestRiskEventVersionsRouteToTheirCanonicalTopics(t *testing.T) {
	schemas := testSchemas(t)
	v1 := eventFixture(t, "risk-assessed.v1.valid.json")
	record, _, invalid := transform(Message{Topic: rawRisk, Value: rawEvent(t, v1)}, schemas)
	requireReason(t, invalid, "")
	if record.Topic != "greenguard.risk.assessment.v1" {
		t.Fatalf("risk.assessed@1 routed to %q", record.Topic)
	}

	v2 := map[string]any{}
	for key, value := range v1 {
		v2[key] = value
	}
	v2["schema_version"] = json.Number("2")
	payload := map[string]any{}
	for key, value := range v1[fieldPayload].(map[string]any) {
		payload[key] = value
	}
	payload["assessment_version"] = "2"
	payload["policy_id"] = "88888888-8888-4888-8888-888888888888"
	payload["policy_calibrated"] = true
	payload["policy_provenance"] = map[string]any{"source": "test-policy", "status": "active"}
	v2[fieldPayload] = payload
	v2[fieldVersion] = "42"
	record, _, invalid = transform(Message{Topic: rawRisk, Value: rawEvent(t, v2)}, schemas)
	requireReason(t, invalid, "")
	if record.Topic != "greenguard.risk.assessment.v2" {
		t.Fatalf("risk.assessed@2 routed to %q", record.Topic)
	}
	canonical, err := decode(record.Value)
	if err != nil || canonical.(map[string]any)[fieldVersion] != "42" {
		t.Fatalf("risk.assessed@2 envelope stream version was not preserved: %v", err)
	}

	uncalibrated := map[string]any{}
	for key, value := range v2 {
		uncalibrated[key] = value
	}
	uncalibratedPayload := map[string]any{}
	for key, value := range payload {
		uncalibratedPayload[key] = value
	}
	uncalibratedPayload["policy_calibrated"] = false
	uncalibratedPayload["score"] = nil
	uncalibratedPayload["severity"] = "insufficient_data"
	uncalibratedPayload["alert_eligible"] = false
	uncalibratedPayload["reasons"] = []any{"policy_not_calibrated"}
	uncalibrated[fieldPayload] = uncalibratedPayload
	record, _, invalid = transform(Message{Topic: rawRisk, Value: rawEvent(t, uncalibrated)}, schemas)
	requireReason(t, invalid, "")

	uncalibratedPayload["score"] = json.Number("50")
	uncalibratedPayload["severity"] = "warning"
	uncalibratedPayload["alert_eligible"] = true
	_, _, invalid = transform(Message{Topic: rawRisk, Value: rawEvent(t, uncalibrated)}, schemas)
	requireReason(t, invalid, reasonSchema)

	policy := map[string]any{
		"event_id": "f25824f7-a94b-4256-b89f-6f9b4e39cad6", "event_type": typeRiskPolicyChanged,
		"schema_version": json.Number("1"), "occurred_at": "2026-09-21T15:00:01.125000Z",
		"tenant_id": "11111111-1111-4111-8111-111111111111", "aggregate_type": "grain_policy",
		"aggregate_id": "88888888-8888-4888-8888-888888888888", "aggregate_version": "1",
		"correlation_id": "4d9d9d30-d209-446e-99ea-d40ab0953d0d",
		"causation_id":   "0d72ff07-a646-4d41-9b5b-52c5f25e4ca8",
		"traceparent":    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		"payload": map[string]any{
			"policy_id": "88888888-8888-4888-8888-888888888888", "version": "1", "grain_type": "wheat",
			"bin_id": nil, "effective_from": "2026-09-21T15:00:00.000000Z", "effective_to": nil,
			"measurement_thresholds": map[string]any{"temperature_c": map[string]any{
				"warning": json.Number("25"), "critical": json.Number("35"), "unit": "Cel"}},
			"risk_thresholds": map[string]any{"warning_score": json.Number("50"), "critical_score": json.Number("75")},
			"calibrated":      false, "status": "draft", "provenance": map[string]any{"source": "test"},
			"calibration_evidence": nil, "approved_by": nil, "approved_at": nil, "supersedes": nil,
		},
	}
	record, _, invalid = transform(Message{Topic: rawRisk, Value: rawEvent(t, policy)}, schemas)
	requireReason(t, invalid, "")
	if record.Topic != "greenguard.risk.policy.v1" {
		t.Fatalf("risk.policy_changed@1 routed to %q", record.Topic)
	}
}

func TestRiskRoutingRejectsUnknownSchemaVersionsAndWrongSource(t *testing.T) {
	schemas := testSchemas(t)
	assessed := eventFixture(t, "risk-assessed.v1.valid.json")
	assessed["schema_version"] = json.Number("3")
	_, _, invalid := transform(Message{Topic: rawRisk, Value: rawEvent(t, assessed)}, schemas)
	requireReason(t, invalid, reasonUnknown)

	policy := map[string]any{
		"event_type": typeRiskPolicyChanged, "schema_version": json.Number("2"),
	}
	_, invalid = route(policy)
	requireReason(t, invalid, reasonUnknown)

	valid := eventFixture(t, "risk-assessed.v1.valid.json")
	_, _, invalid = transform(Message{Topic: rawInventory, Value: rawEvent(t, valid)}, schemas)
	requireReason(t, invalid, reasonEnvelope)
}
