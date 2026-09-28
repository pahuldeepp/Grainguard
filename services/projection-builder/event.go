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
	typeSiteChanged    = "site.changed"
	typeBinChanged     = "bin.changed"
	typeCableLayout    = "cable.layout_changed"
	typeRiskAssessed   = "risk.assessed"
	typeRiskPolicy     = "risk.policy_changed"
	typeRegistered     = "device.registered"
	typeBinding        = "device.binding_changed"
	typeStatus         = "device.status_changed"
	topicTelemetry     = "greenguard.telemetry.recorded.v1"
	topicTelemetryV2   = "greenguard.telemetry.recorded.v2"
	topicInventory     = "greenguard.inventory.device.v1"
	topicFacility      = "greenguard.inventory.facility.v1"
	topicSensorLayout  = "greenguard.inventory.sensor-layout.v1"
	topicRiskV1        = "greenguard.risk.assessment.v1"
	topicRiskV2        = "greenguard.risk.assessment.v2"
	topicRiskPolicy    = "greenguard.risk.policy.v1"
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

var eventTopics = map[string]string{
	typeTelemetry + "@1":    topicTelemetry,
	typeTelemetry + "@2":    topicTelemetryV2,
	typeRegistered + "@1":   topicInventory,
	typeBinding + "@1":      topicInventory,
	typeStatus + "@1":       topicInventory,
	typeSiteChanged + "@1":  topicFacility,
	typeBinChanged + "@1":   topicFacility,
	typeCableLayout + "@1":  topicSensorLayout,
	typeRiskAssessed + "@1": topicRiskV1,
	typeRiskAssessed + "@2": topicRiskV2,
	typeRiskPolicy + "@1":   topicRiskPolicy,
}

var projectionTopics = []string{
	topicInventory, topicTelemetry, topicTelemetryV2, topicFacility,
	topicSensorLayout, topicRiskV1, topicRiskV2, topicRiskPolicy,
}

func route(event map[string]any) string {
	return eventTopics[routingKey(event)]
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
	version, err := bigint(event[fieldVersion])
	if err != nil {
		return err
	}
	parent := event[fieldTrace].(string)
	if strings.HasPrefix(parent, "00-"+strings.Repeat("0", 32)+"-") || strings.Split(parent, "-")[2] == strings.Repeat("0", 16) {
		return fail(reasonSchema, "trace and parent IDs must not be zero")
	}
	switch event[fieldType] {
	case typeTelemetry, typeRegistered, typeBinding, typeStatus:
		if err := payloadIdentities(payload); err != nil {
			return err
		}
		binding, bad := bigint(payload[fieldBinding])
		if bad != nil {
			return bad
		}
		if payload[fieldDevice] != event[fieldAggregate] || (event[fieldAggregateType] == "device" && binding != version) {
			return fail(reasonSchema, "device identity and binding version must match aggregate")
		}
		if event[fieldType] == typeTelemetry && fmt.Sprint(event[fieldSchema]) == "2" {
			if err := common.ValidateTelemetryV2(payload); err != nil {
				return fail(reasonSchema, err.Error())
			}
		}
	case typeSiteChanged:
		if payload["site_id"] != event[fieldAggregate] || payload["site_version"] != version {
			return fail(reasonSchema, "site identity and version must match aggregate")
		}
	case typeBinChanged:
		if payload["bin_id"] != event[fieldAggregate] || payload["bin_version"] != version {
			return fail(reasonSchema, "bin identity and version must match aggregate")
		}
	case typeCableLayout:
		if payload["cable_id"] != event[fieldAggregate] || payload["cable_version"] != version {
			return fail(reasonSchema, "cable identity and version must match aggregate")
		}
		if failure := uniqueCableSensors(payload["sensors"]); failure != nil {
			return failure
		}
	case typeRiskPolicy:
		policyVersion, bad := bigint(payload["version"])
		if bad != nil {
			return bad
		}
		if payload["policy_id"] != event[fieldAggregate] || policyVersion != version {
			return fail(reasonSchema, "policy identity and version must match aggregate")
		}
	case typeRiskAssessed:
		if payload[fieldDevice] != event[fieldAggregate] {
			return fail(reasonSchema, "assessment device must match aggregate")
		}
	}
	return nil
}

func uniqueCableSensors(value any) *failure {
	sensors, ok := value.([]any)
	if !ok {
		return fail(reasonSchema, "cable sensors must be an array")
	}
	ids, positions := map[string]bool{}, map[any]bool{}
	for _, item := range sensors {
		sensor, ok := item.(map[string]any)
		if !ok {
			return fail(reasonSchema, "cable sensor must be an object")
		}
		id := fmt.Sprint(sensor["sensor_id"])
		position := sensor["position"]
		if ids[id] || positions[position] {
			return fail(reasonSchema, "cable sensor identities and positions must be unique")
		}
		ids[id], positions[position] = true, true
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
