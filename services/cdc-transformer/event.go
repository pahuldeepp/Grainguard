package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	common "greenguard.local/go-common"
	"regexp"
	"strings"
	"time"
)

const (
	reasonEnvelope       = "bad_envelope"
	reasonOp             = "unsupported_op"
	reasonMissing        = "missing_field"
	reasonSchema         = "schema_invalid"
	reasonUnknown        = "unknown_event_type"
	reasonTimestamp      = "bad_timestamp"
	reasonBigint         = "bad_bigint"
	fieldPayload         = "payload"
	fieldTenant          = "tenant_id"
	fieldType            = "event_type"
	fieldSchema          = "schema_version"
	fieldVersion         = "aggregate_version"
	fieldAggregate       = "aggregate_id"
	fieldTrace           = "traceparent"
	fieldBinding         = "binding_version"
	fieldOccurred        = "occurred_at"
	fieldEvent           = "event_id"
	fieldCorrelation     = "correlation_id"
	fieldCausation       = "causation_id"
	fieldAggregateType   = "aggregate_type"
	fieldDevice          = "device_id"
	typeTelemetry        = "telemetry.recorded"
	typeRegistered       = "device.registered"
	typeBinding          = "device.binding_changed"
	typeStatus           = "device.status_changed"
	typeSiteChanged      = "site.changed"
	typeBinChanged       = "bin.changed"
	typeLotChanged       = "lot.changed"
	typeRiskAssessed     = "risk.assessed"
	typeRiskInvalidated  = "risk.assessment_invalidated"
	typeAlertOpened      = "alert.opened"
	typeAlertUpdated     = "alert.updated"
	typeAlertAcked       = "alert.acknowledged"
	typeAlertEscalated   = "alert.escalated"
	typeAlertResolved    = "alert.resolved"
	topicFacility        = "greenguard.inventory.facility.v1"
	topicLot             = "greenguard.inventory.lot.v1"
	rawInventory         = "greenguard.raw.inventory.outbox"
	rawTelemetry         = "greenguard.raw.telemetry.outbox"
	rawRisk              = "greenguard.raw.risk.outbox"
	rawAlerts            = "greenguard.raw.alerts.outbox"
	topicTelemetry       = "greenguard.telemetry.recorded.v1"
	topicInventory       = "greenguard.inventory.device.v1"
	topicRisk            = "greenguard.risk.assessment.v1"
	topicRiskInvalidated = "greenguard.risk.assessment_invalidated.v1"
	topicAlerts          = "greenguard.alerts.lifecycle.v1"
	topicQuarantine      = "greenguard.quarantine.v1"
	opTombstone          = "tombstone"
	microLayout          = "2006-01-02T15:04:05.000000Z"
)

var fields = []string{fieldEvent, fieldType, fieldSchema, fieldOccurred, fieldTenant, fieldAggregateType, fieldAggregate, fieldVersion, fieldCorrelation, fieldCausation, fieldTrace, fieldPayload}

type failure struct{ Reason, Detail string }

func (f *failure) Error() string          { return f.Reason + ": " + f.Detail }
func fail(reason, detail string) *failure { return &failure{reason, detail} }

// decode preserves integer precision and rejects trailing JSON values.
func decode(raw []byte) (any, error) {
	return common.Decode(raw)
}

func unwrap(raw []byte) (map[string]any, string, *failure) {
	if raw == nil || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, opTombstone, nil
	}
	value, err := decode(raw)
	if err != nil {
		return nil, "", fail(reasonEnvelope, "invalid envelope JSON")
	}
	outer, ok := value.(map[string]any)
	if !ok {
		return nil, "", fail(reasonEnvelope, "envelope must be an object")
	}
	// schemas.enable=false normally emits the envelope directly. Also accept the
	// payload wrapper used by existing fixtures and schema-enabled JSON converters.
	envelope := outer
	if wrapped, exists := outer[fieldPayload]; exists {
		envelope, ok = wrapped.(map[string]any)
		if !ok {
			return nil, "", fail(reasonEnvelope, "envelope payload must be an object")
		}
	}
	return unwrapOperation(envelope)
}

func unwrapOperation(envelope map[string]any) (map[string]any, string, *failure) {
	op, ok := envelope["op"].(string)
	if !ok || op == "" {
		return nil, "", fail(reasonEnvelope, "missing operation")
	}
	switch op {
	case "u", "d":
		return nil, op, nil
	case "c", "r":
		source, ok := envelope["source"].(map[string]any)
		if !ok || source["table"] != "outbox_events" {
			return nil, "", fail(reasonEnvelope, "source must be outbox_events")
		}
		row, ok := envelope["after"].(map[string]any)
		if !ok {
			return nil, "", fail(reasonEnvelope, "after must be an outbox row")
		}
		return row, "", nil
	default:
		return nil, "", fail(reasonOp, "unsupported operation")
	}
}

func mapRow(row map[string]any) (map[string]any, *failure) {
	event := make(map[string]any, len(fields))
	for _, key := range fields {
		value, ok := row[key]
		if !ok || value == nil {
			return nil, fail(reasonMissing, key+" is required")
		}
		event[key] = value
	}
	version, err := bigint(event[fieldVersion])
	if err != nil {
		return nil, err
	}
	event[fieldVersion] = version
	timestamp, err := occurredAt(event[fieldOccurred])
	if err != nil {
		return nil, err
	}
	event[fieldOccurred] = timestamp
	if payload, ok := event[fieldPayload].(string); ok {
		parsed, err := decode([]byte(payload))
		if err != nil {
			return nil, fail(reasonSchema, "invalid JSONB payload")
		}
		event[fieldPayload] = parsed
	}
	return event, nil
}

func bigint(value any) (string, *failure) {
	text, err := common.Bigint(value)
	if err != nil {
		return "", fail(reasonBigint, err.Error())
	}
	return text, nil
}

var timestampPattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$`)

func occurredAt(value any) (string, *failure) {
	var timestamp time.Time
	switch v := value.(type) {
	case string:
		parsed, err := time.Parse(time.RFC3339Nano, v)
		if err != nil || !timestampPattern.MatchString(v) {
			return "", fail(reasonTimestamp, "timestamp must have microsecond precision")
		}
		timestamp = parsed.UTC()
	case json.Number:
		micros, err := v.Int64()
		if err != nil {
			return "", fail(reasonTimestamp, "timestamp epoch must be integer microseconds")
		}
		timestamp = time.UnixMicro(micros).UTC()
	default:
		return "", fail(reasonTimestamp, "timestamp must be ISO8601 or epoch microseconds")
	}
	if timestamp.Year() < 0 || timestamp.Year() > 9999 {
		return "", fail(reasonTimestamp, "timestamp year out of range")
	}
	return timestamp.Format(microLayout), nil
}

func route(event map[string]any) (string, *failure) {
	switch event[fieldType] {
	case typeTelemetry:
		return topicTelemetry, nil
	case typeRegistered, typeBinding, typeStatus:
		return topicInventory, nil
	case typeSiteChanged, typeBinChanged:
		return topicFacility, nil
	case typeLotChanged:
		return topicLot, nil
	case typeRiskAssessed:
		return topicRisk, nil
	case typeRiskInvalidated:
		return topicRiskInvalidated, nil
	case typeAlertOpened, typeAlertUpdated, typeAlertAcked, typeAlertEscalated, typeAlertResolved:
		return topicAlerts, nil
	default:
		return "", fail(reasonUnknown, "event type is not allowlisted")
	}
}

func routingKey(event map[string]any) string {
	return fmt.Sprint(event[fieldType]) + "@" + fmt.Sprint(event[fieldSchema])
}

func semantic(event map[string]any) *failure {
	if err := identitySemantic(event); err != nil {
		return err
	}
	payload := event[fieldPayload].(map[string]any) // schema validated before semantics
	if event[fieldType] == typeLotChanged {
		if err := lotSemantic(payload); err != nil {
			return err
		}
	}
	if event[fieldType] == typeRiskAssessed {
		if err := riskSemantic(event, payload); err != nil {
			return err
		}
	}
	if event[fieldAggregateType] == "alert_episode" {
		if err := alertSemantic(event, payload); err != nil {
			return err
		}
	}
	parent := event[fieldTrace].(string)
	if strings.HasPrefix(parent, "00-"+strings.Repeat("0", 32)+"-") || strings.Split(parent, "-")[2] == strings.Repeat("0", 16) {
		return fail(reasonSchema, "trace and parent IDs must not be zero")
	}
	return nil
}

func identitySemantic(event map[string]any) *failure {
	for _, key := range []string{fieldTenant, fieldEvent, fieldAggregate, fieldCorrelation, fieldCausation} {
		if event[key] == "00000000-0000-0000-0000-000000000000" {
			return fail(reasonSchema, key+" must not be nil UUID")
		}
	}
	payload := event[fieldPayload].(map[string]any) // schema validated before semantics
	identity, version := payloadFields(event)
	for _, value := range []any{event[fieldVersion], payload[version]} {
		if _, err := bigint(value); err != nil {
			return err
		}
	}
	if payload[identity] != event[fieldAggregate] || (event[fieldType] != typeTelemetry && payload[version] != event[fieldVersion]) {
		return fail(reasonSchema, "payload identity and version must match aggregate")
	}
	return nil
}

func riskSemantic(event, payload map[string]any) *failure {
	if payload["source_event_id"] != event[fieldCausation] {
		return fail(reasonSchema, "risk source_event_id must match causation_id")
	}
	insufficient := payload["severity"] == "insufficient_data"
	if (payload["score"] == nil) != insufficient {
		return fail(reasonSchema, "risk score must be null exactly when data is insufficient")
	}
	eligible := payload["severity"] == "warning" || payload["severity"] == "critical"
	if payload["alert_eligible"] != eligible {
		return fail(reasonSchema, "risk alert eligibility does not match severity")
	}
	return nil
}

func alertSemantic(event, payload map[string]any) *failure {
	states := map[any][]any{
		typeAlertOpened: {"open"}, typeAlertUpdated: {"open", "acknowledged"},
		typeAlertAcked: {"acknowledged"}, typeAlertEscalated: {"open"}, typeAlertResolved: {"resolved"},
	}
	allowed := false
	for _, state := range states[event[fieldType]] {
		if payload["state"] == state {
			allowed = true
		}
	}
	if !allowed {
		return fail(reasonSchema, "alert event state does not match transition")
	}
	if payload["source_event_id"] != nil && payload["source_event_id"] != event[fieldCausation] {
		return fail(reasonSchema, "alert source_event_id must match causation_id")
	}
	riskCaused := event[fieldType] == typeAlertOpened || event[fieldType] == typeAlertUpdated || event[fieldType] == typeAlertResolved
	if (payload["source_event_id"] != nil) != riskCaused {
		return fail(reasonSchema, "alert source_event_id is required exactly for risk-caused transitions")
	}
	if event[fieldType] == typeAlertAcked && payload["acknowledged_by"] == nil {
		return fail(reasonSchema, "acknowledged alert requires actor")
	}
	return nil
}

func lotSemantic(payload map[string]any) *failure {
	for _, key := range []string{"site_id", "lot_id", "previous_lot_id"} {
		if payload[key] == "00000000-0000-0000-0000-000000000000" {
			return fail(reasonSchema, key+" must not be nil UUID")
		}
	}
	if payload["lot_id"] == payload["previous_lot_id"] {
		return fail(reasonSchema, "lot_id must differ from previous_lot_id")
	}
	return nil
}

// Schemas establish the aggregate kind before selecting its semantic fields.
func payloadFields(event map[string]any) (string, string) {
	switch event[fieldAggregateType] {
	case "site":
		return "site_id", "site_version"
	case "bin":
		return "bin_id", "bin_version"
	case "bin_occupancy":
		return "bin_id", "occupancy_version"
	case "device_risk_stream":
		return "device_id", "assessment_version"
	case "alert_episode":
		return "episode_id", "episode_version"
	default:
		return fieldDevice, fieldBinding
	}
}
