package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	common "greenguard.local/go-common"
	"io"
	"path/filepath"
	"strconv"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/twmb/franz-go/pkg/kgo"
	"greenguard.local/cassandra-writer/history"
)

const (
	topicTelemetry   = "greenguard.telemetry.recorded.v1"
	topicTelemetryV2 = "greenguard.telemetry.recorded.v2"
	topicQuarantine  = "greenguard.quarantine.v1"
	typeTelemetry    = "telemetry.recorded"
	fieldTenant      = "tenant_id"
	fieldEvent       = "event_id"
	fieldType        = "event_type"
	fieldSchema      = "schema_version"
	fieldAggregate   = "aggregate_id"
	fieldTrace       = "traceparent"
	fieldPayload     = "payload"
	fieldDevice      = "device_id"
	reasonEnvelope   = "bad_envelope"
	reasonSchema     = "schema_invalid"
	reasonKey        = "key_mismatch"
	reasonHeaders    = "header_mismatch"
	reasonRejected   = "cassandra_rejected"
	schemaFile       = "telemetry-recorded.v1.schema.json"
)

// Validator checks a canonical event against the shared repository schema.
type Validator interface{ Validate(any) error }

type telemetrySchemas map[string]*jsonschema.Schema

func (s telemetrySchemas) Validate(value any) error {
	event, ok := value.(map[string]any)
	if !ok {
		return errors.New("invalid telemetry envelope")
	}
	schema := s[fmt.Sprint(event[fieldSchema])]
	if schema == nil {
		return errors.New("unsupported telemetry schema")
	}
	if err := schema.Validate(value); err != nil {
		return err
	}
	if fmt.Sprint(event[fieldSchema]) == "2" {
		return common.ValidateTelemetryV2(event[fieldPayload].(map[string]any))
	}
	return nil
}

func loadSchema(dir string) (Validator, error) {
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	result := telemetrySchemas{}
	for version, file := range map[string]string{"1": schemaFile, "2": "telemetry-recorded.v2.schema.json"} {
		schema, err := compiler.Compile(filepath.Join(dir, file))
		if err != nil {
			return nil, err
		}
		result[version] = schema
	}
	return result, nil
}

func decode(raw []byte) (map[string]any, bool) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var value map[string]any
	if d.Decode(&value) != nil || value == nil {
		return nil, false
	}
	var extra any
	return value, d.Decode(&extra) == io.EOF
}

// parse validates one record and maps it to a history row. A non-empty reason
// means the record is quarantined; it never reaches Cassandra.
func parse(schema Validator, m Message) (history.Reading, map[string]any, string) {
	e, ok := decode(m.Value)
	if !ok {
		return history.Reading{}, nil, reasonEnvelope
	}
	if e[fieldType] != typeTelemetry || schema.Validate(e) != nil {
		return history.Reading{}, e, reasonSchema
	}
	expectedTopic := topicTelemetry
	if fmt.Sprint(e[fieldSchema]) == "2" {
		expectedTopic = topicTelemetryV2
	}
	if m.Topic != expectedTopic || string(m.Key) != fmt.Sprint(e[fieldTenant])+":"+fmt.Sprint(e[fieldAggregate]) {
		return history.Reading{}, e, reasonKey
	}
	if !validHeaders(m.Headers, e) {
		return history.Reading{}, e, reasonHeaders
	}
	r, ok := reading(e)
	if !ok {
		return history.Reading{}, e, reasonSchema
	}
	return r, e, ""
}

func validHeaders(headers []kgo.RecordHeader, e map[string]any) bool {
	values := map[string]string{}
	for _, h := range headers {
		if _, dup := values[h.Key]; dup {
			return false
		}
		values[h.Key] = string(h.Value)
	}
	for _, key := range []string{fieldEvent, fieldType, fieldSchema, fieldTenant} {
		if values[key] != fmt.Sprint(e[key]) {
			return false
		}
	}
	return true
}

func reading(e map[string]any) (history.Reading, bool) {
	p := e[fieldPayload].(map[string]any) // schema validated
	r := history.Reading{TenantID: str(e, fieldTenant), EventID: str(e, fieldEvent), DeviceID: str(p, fieldDevice), ReadingID: str(p, "reading_id"), SiteID: str(p, "site_id"), BinID: str(p, "bin_id")}
	version, err := strconv.ParseInt(fmt.Sprint(e["aggregate_version"]), 10, 64)
	observed, errObserved := time.Parse(time.RFC3339Nano, str(p, "observed_at"))
	received, errReceived := time.Parse(time.RFC3339Nano, str(p, "received_at"))
	if err != nil || version < 1 || errObserved != nil || errReceived != nil || r.DeviceID != str(e, fieldAggregate) {
		return r, false
	}
	for _, id := range []string{r.TenantID, r.EventID, r.DeviceID, r.ReadingID, r.SiteID} {
		if !history.ValidID(id) {
			return r, false
		}
	}
	// The canonical telemetry contract permits an unbound device. An absent
	// bin is represented by a null CQL column, not a rejected reading.
	if r.BinID != "" && !history.ValidID(r.BinID) {
		return r, false
	}
	r.StreamVersion, r.ObservedAt, r.ReceivedAt = version, observed, received
	measurements, _ := p["measurements"].(map[string]any)
	r.TemperatureC = number(measurements, "temperature_c")
	r.RelativeHumidityPercent = number(measurements, "relative_humidity_percent")
	if fmt.Sprint(e[fieldSchema]) == "2" {
		r.SchemaVersion = 2
		r.CO2PPM = number(measurements, "co2_ppm")
		r.GrainMoisturePercent = number(measurements, "grain_moisture_percent")
		units, _ := json.Marshal(p["measurement_units"])
		r.MeasurementUnits = string(units)
		if samples, ok := p["sensor_observations"]; ok {
			data, _ := json.Marshal(samples)
			r.SensorObservations = string(data)
		}
	}
	return r, true
}

func str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func number(m map[string]any, key string) *float64 {
	n, ok := m[key].(json.Number)
	if !ok {
		return nil
	}
	f, err := n.Float64()
	if err != nil {
		return nil
	}
	return &f
}
