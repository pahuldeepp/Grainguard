package main

import (
	"fmt"
	common "greenguard.local/go-common"
	"strings"
)

const (
	reasonEnvelope     = "bad_envelope"
	reasonSchema       = "schema_invalid"
	reasonUnknown      = "unknown_event_type"
	reasonBigint       = "bad_bigint"
	fieldPayload       = "payload"
	fieldTenant        = "tenant_id"
	fieldType          = "event_type"
	fieldSchema        = "schema_version"
	fieldVersion       = "aggregate_version"
	fieldAggregate     = "aggregate_id"
	fieldTrace         = "traceparent"
	fieldBinding       = "binding_version"
	fieldOccurred      = "occurred_at"
	fieldEvent         = "event_id"
	fieldCorrelation   = "correlation_id"
	fieldCausation     = "causation_id"
	fieldAggregateType = "aggregate_type"
	fieldDevice        = "device_id"
	typeTelemetry      = "telemetry.recorded"
	typeRegistered     = "device.registered"
	typeBinding        = "device.binding_changed"
	typeStatus         = "device.status_changed"
	topicTelemetry     = "greenguard.telemetry.recorded.v1"
	topicInventory     = "greenguard.inventory.device.v1"
	topicQuarantine    = "greenguard.quarantine.v1"
)

type failure struct{ Reason, Detail string }

func (f *failure) Error() string          { return f.Reason + ": " + f.Detail }
func fail(reason, detail string) *failure { return &failure{reason, detail} }

// decode preserves integer precision and rejects trailing JSON values.
func decode(raw []byte) (any, error) {
	return common.Decode(raw)
}

func bigint(value any) (string, *failure) {
	text, err := common.Bigint(value)
	if err != nil {
		return "", fail(reasonBigint, err.Error())
	}
	return text, nil
}

var eventTopics = map[string]string{typeTelemetry: topicTelemetry, typeRegistered: topicInventory, typeBinding: topicInventory, typeStatus: topicInventory}

func route(event map[string]any) string {
	kind, _ := event[fieldType].(string)
	return eventTopics[kind]
}

func routingKey(event map[string]any) string {
	return fmt.Sprint(event[fieldType]) + "@" + fmt.Sprint(event[fieldSchema])
}

func semantic(event map[string]any) *failure {
	for _, key := range []string{fieldTenant, fieldEvent, fieldAggregate, fieldCorrelation, fieldCausation} {
		if event[key] == "00000000-0000-0000-0000-000000000000" {
			return fail(reasonSchema, key+" must not be nil UUID")
		}
	}
	tenant, _ := event[fieldTenant].(string)
	if tenant == infrastructureTenant || !tenantPattern.MatchString(tenant) {
		return fail(reasonSchema, "reserved infrastructure tenant")
	}
	payload := event[fieldPayload].(map[string]any) // schema validated before semantics
	if err := payloadIdentities(payload); err != nil {
		return err
	}
	for _, value := range []any{event[fieldVersion], payload[fieldBinding]} {
		if _, err := bigint(value); err != nil {
			return err
		}
	}
	if payload[fieldDevice] != event[fieldAggregate] || (event[fieldAggregateType] == "device" && payload[fieldBinding] != event[fieldVersion]) {
		return fail(reasonSchema, "device identity and binding version must match aggregate")
	}
	parent := event[fieldTrace].(string)
	if strings.HasPrefix(parent, "00-"+strings.Repeat("0", 32)+"-") || strings.Split(parent, "-")[2] == strings.Repeat("0", 16) {
		return fail(reasonSchema, "trace and parent IDs must not be zero")
	}
	return nil
}

func payloadIdentities(payload map[string]any) *failure {
	for _, key := range []string{fieldDevice, "reading_id", "site_id", "bin_id"} {
		if payload[key] == "00000000-0000-0000-0000-000000000000" {
			return fail(reasonSchema, "nil payload identity")
		}
	}
	return nil
}
