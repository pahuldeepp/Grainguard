package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
	"os"
	"strings"
	"testing"
)

func v2Body(extra string) []byte { return []byte(ingReading(`,"schema_version":2` + extra)) }

const sampleV2 = `,"measurement_units":{},"sensor_observations":[{"sensor_id":"77777777-7777-4777-8777-777777777777","metric":"co2_ppm","value":450,"unit":"ppm"}]`

func TestV2QualityFinitePhysicalUnitsSparseAndIdentity(t *testing.T) {
	for _, extra := range []string{
		`,"co2_ppm":0,"measurement_units":{"co2_ppm":"ppm"}`,
		`,"co2_ppm":1e12,"measurement_units":{"co2_ppm":"ppm"}`,
		`,"temperature_c":null,"grain_moisture_percent":0,"measurement_units":{"grain_moisture_percent":"%"}`,
		sampleV2,
	} {
		req, rej := ParseReadingRequest(v2Body(extra), ingNow, QualityPolicy{})
		if rej != nil || req.SchemaVersion != 2 {
			t.Fatalf("%s: %+v %+v", extra, req, rej)
		}
		if req.RelativeHumidityPercent != nil {
			t.Fatal("RH must remain absent")
		}
	}
	for _, tc := range []struct{ extra, reason string }{
		{`,"co2_ppm":-1,"measurement_units":{"co2_ppm":"ppm"}`, ReasonValueOutOfRange},
		{`,"co2_ppm":1e999,"measurement_units":{"co2_ppm":"ppm"}`, ReasonNonFiniteValue},
		{`,"grain_moisture_percent":101,"measurement_units":{"grain_moisture_percent":"%"}`, ReasonValueOutOfRange},
		{`,"grain_moisture_percent":14,"measurement_units":{"grain_moisture_percent":"ppm"}`, ReasonInvalidField},
		{`,"co2_ppm":450,"measurement_units":{}`, ReasonInvalidField},
		{`,"measurement_units":{}`, ReasonNoMeasurements},
		{strings.Replace(sampleV2, `"value":450`, `"value":null`, 1), ReasonInvalidField},
		{strings.Replace(sampleV2, `"value":450`, `"value":1e999`, 1), ReasonNonFiniteValue},
		{strings.Replace(sampleV2, `"unit":"ppm"`, `"unit":"%"`, 1), ReasonInvalidField},
		{strings.Replace(sampleV2, `"unit":"ppm"`, `"unit":"ppm","layout_version":"1"`, 1), ReasonInvalidField},
	} {
		_, rej := ParseReadingRequest(v2Body(tc.extra), ingNow, QualityPolicy{})
		if rej == nil || rej.Reason != tc.reason {
			t.Fatalf("%s: got %+v", tc.extra, rej)
		}
	}
	duplicate := strings.Replace(sampleV2, `}]`, `},{"sensor_id":"77777777-7777-4777-8777-777777777777","metric":"co2_ppm","value":460,"unit":"ppm"}]`, 1)
	if _, rej := ParseReadingRequest(v2Body(duplicate), ingNow, QualityPolicy{}); rej == nil {
		t.Fatal("duplicate sample identity accepted")
	}
}

func TestV2EmissionDisabledByDefaultAndRetainedReceiptReplay(t *testing.T) {
	steps := ingHappySteps(bindingActive)[:3]
	g := ingScripted(steps)
	tenant, device := randomUUID(), randomUUID()
	p := Principal{Subject: device, TenantID: tenant, Roles: []string{RoleDevice}}
	body := v2Body(`,"co2_ppm":450,"measurement_units":{"co2_ppm":"ppm"}`)
	_, err := g.Ingest(context.Background(), p, device, body, ingMeta())
	ingMustReject(t, err, ReasonTelemetryV2Disabled, 503)
	ack := IngestResult{Status: "stored", ReadingID: randomUUID(), EventID: randomUUID(), StreamVersion: "42", ProjectionStatus: "pending"}
	data, _ := json.Marshal(ack)
	steps[2] = step{scan: func(dest []any) { *(dest[0].(*[]byte)) = data; *(dest[1].(*bool)) = true }}
	result, err := ingScripted(steps).Ingest(context.Background(), p, device, body, ingMeta())
	if err != nil || result != ack {
		t.Fatalf("disabled-gate receipt replay %+v %v", result, err)
	}
	for raw, want := range map[string]bool{"": false, "0": false, "1": true} {
		cfg, err := loadIngestConfig(env(map[string]string{"INGEST_TELEMETRY_V2_ENABLED": raw}))
		if err != nil || cfg.TelemetryV2Enabled != want {
			t.Fatalf("gate %q %+v %v", raw, cfg, err)
		}
	}
	if _, err := loadIngestConfig(env(map[string]string{"INGEST_TELEMETRY_V2_ENABLED": "true"})); err == nil {
		t.Fatal("ambiguous gate accepted")
	}
}

func TestV2SensorAssociationFailsClosedAndPayloadRetainsProvenance(t *testing.T) {
	req, rej := parseReadingRequest(v2Body(sampleV2))
	if rej != nil {
		t.Fatal(rej)
	}
	a := attempt{req: req, principal: Principal{TenantID: randomUUID()}, deviceID: randomUUID()}
	if err := resolveSensorObservations(context.Background(), nil, &a, storedBinding{}); err == nil {
		t.Fatal("missing inventory accepted")
	}
	cable := randomUUID()
	depth := 1.5
	a.sensors = func(_ context.Context, _ pgx.Tx, tenant, device string, _ *string, sensor string) (SensorLayout, error) {
		if tenant != a.principal.TenantID || device != a.deviceID || sensor != req.SensorObservations[0].SensorID {
			t.Fatal("resolver lost authenticated scope")
		}
		return SensorLayout{CableID: cable, LayoutVersion: "2", Position: 1, DepthM: &depth}, nil
	}
	if err := resolveSensorObservations(context.Background(), nil, &a, storedBinding{}); err != nil {
		t.Fatal(err)
	}
	r := record{attempt: a}
	payload := r.payloadJSON()
	if !strings.Contains(payload, `"layout_version":"2"`) || !strings.Contains(payload, `"depth_m":1.5`) || !strings.Contains(payload, `"measurements":{}`) || strings.Contains(payload, `"temperature_c"`) {
		t.Fatal(payload)
	}
}

func TestV1SerializedPayloadRetainsExactBytes(t *testing.T) {
	temp := 28.75
	humidity := 66.2
	bin := "55555555-5555-4555-8555-555555555555"
	r := record{attempt: attempt{deviceID: "33333333-3333-4333-8333-333333333333", req: ReadingRequest{SourceMessageID: "sensor-003.boot-018.reading-000042", ObservedAt: ingNow.Add(-123456000).Add(-500000000), TemperatureC: &temp, RelativeHumidityPercent: &humidity}, now: ingNow.Add(-23456000)}, readingID: "bb70cd06-0720-461a-8ecf-a56754985f87", binding: storedBinding{siteID: "22222222-2222-4222-8222-222222222222", binID: &bin, version: 3}}
	expected := `{"reading_id":"bb70cd06-0720-461a-8ecf-a56754985f87","device_id":"33333333-3333-4333-8333-333333333333","site_id":"22222222-2222-4222-8222-222222222222","bin_id":"55555555-5555-4555-8555-555555555555","binding_version":"3","source_message_id":"sensor-003.boot-018.reading-000042","observed_at":"2026-09-21T14:59:59.500000Z","received_at":"2026-09-21T15:00:00.100000Z","measurements":{"temperature_c":28.75,"relative_humidity_percent":66.2}}`
	if got := r.payloadJSON(); got != expected {
		t.Fatalf("legacy bytes changed:\n%s", got)
	}
}

func layoutFixture(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("../../tests/fixtures/events/cable-layout-changed.v1.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestOwnerLayoutSnapshotDuplicateStaleGapAndConflictingIdentity(t *testing.T) {
	raw := layoutFixture(t)
	for _, tc := range []struct {
		name    string
		steps   []step
		outcome BindingOutcome
		err     error
	}{
		{"first", []step{{rows: 1}, {rows: 1}, {err: pgx.ErrNoRows}, {rows: 1}}, BindingApplied, nil},
		{"duplicate", []step{{rows: 1}, {rows: 0}, {scan: setBool(true)}}, BindingDuplicate, nil},
		{"conflict", []step{{rows: 1}, {rows: 0}, {scan: setBool(false)}}, "", ErrEventConflict},
		{"stale", []step{{rows: 1}, {rows: 1}, {scan: setInt64(1)}}, BindingStale, nil},
	} {
		outcome, err := ApplyLayoutEvent(context.Background(), scriptDB{tc.steps}, raw)
		if !errors.Is(err, tc.err) || (err == nil && outcome != tc.outcome) {
			t.Fatalf("%s: %s %v", tc.name, outcome, err)
		}
	}
	var e map[string]any
	_ = json.Unmarshal(raw, &e)
	e["aggregate_version"] = "3"
	e["payload"].(map[string]any)["cable_version"] = "3"
	raw, _ = json.Marshal(e)
	_, err := ApplyLayoutEvent(context.Background(), scriptDB{[]step{{rows: 1}, {rows: 1}, {scan: setInt64(1)}}}, raw)
	if !errors.Is(err, ErrVersionGap) {
		t.Fatalf("gap=%v", err)
	}
}

func TestV2LiveSensorAssociationTenantIsolationAndImmutableReplay(t *testing.T) {
	f := ingSetup(t)
	f.ingestor.v2Enabled = true
	f.ingestor.sensors = resolveLocalSensor
	var event map[string]any
	_ = json.Unmarshal(layoutFixture(t), &event)
	event["tenant_id"] = f.tenant
	payload := event["payload"].(map[string]any)
	payload["device_id"] = f.device
	payload["bin_id"] = f.bin
	raw, _ := json.Marshal(event)
	if _, err := ApplyLayoutEvent(context.Background(), f.db, raw); err != nil {
		t.Fatal(err)
	}
	sensor := payload["sensors"].([]any)[0].(map[string]any)["sensor_id"].(string)
	extra := strings.Replace(sampleV2, "77777777-7777-4777-8777-777777777777", sensor, 1)
	ack, err := f.ingestor.Ingest(context.Background(), f.principal(), f.device, v2Body(extra), ingMeta())
	if err != nil {
		t.Fatal(err)
	}
	eventBytes := ingLoadEvent(t, adminConn(t, ingTelemetryDB), ack.EventID)
	schema, err := common.CompileSchemas("../../contracts/events", map[string]string{"v2": "telemetry-recorded.v2.schema.json"})
	if err != nil {
		t.Fatal(err)
	}
	value, err := common.Decode(eventBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := schema["v2"].Validate(value); err != nil {
		t.Fatalf("produced v2 schema: %v", err)
	}
	if err := common.ValidateTelemetryV2(value.(map[string]any)["payload"].(map[string]any)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(eventBytes), `"layout_version": "1"`) || !strings.Contains(string(eventBytes), `"measurement_units": {}`) {
		t.Fatalf("event %s", eventBytes)
	}
	// Both an explicit foreign tenant and an RLS-hidden tenant must be denied.
	err = WithTenant(context.Background(), f.db, randomUUID(), func(ctx context.Context, tx pgx.Tx) error {
		_, err := resolveLocalSensor(ctx, tx, f.tenant, f.device, &f.bin, sensor)
		return err
	})
	ingMustReject(t, err, ReasonSensorForbidden, 403)
	err = WithTenant(context.Background(), f.db, f.tenant, func(ctx context.Context, tx pgx.Tx) error {
		_, err := resolveLocalSensor(ctx, tx, f.tenant, randomUUID(), &f.bin, sensor)
		return err
	})
	ingMustReject(t, err, ReasonSensorForbidden, 403)
	// Removing a sensor invalidates new observations but cannot rewrite a prior receipt.
	event["event_id"] = randomUUID()
	event["aggregate_version"] = "2"
	payload["cable_version"] = "2"
	payload["operation"] = "deleted"
	payload["sensors"] = []any{}
	raw, _ = json.Marshal(event)
	if _, err := ApplyLayoutEvent(context.Background(), f.db, raw); err != nil {
		t.Fatal(err)
	}
	f.ingestor.v2Enabled = false
	replay, err := f.ingestor.Ingest(context.Background(), f.principal(), f.device, v2Body(extra), ingMeta())
	if err != nil || replay != ack {
		t.Fatalf("retained receipt %+v %v", replay, err)
	}
	changed := strings.Replace(string(v2Body(extra)), `"value":450`, `"value":451`, 1)
	_, err = f.ingestor.Ingest(context.Background(), f.principal(), f.device, []byte(changed), ingMeta())
	ingMustReject(t, err, ReasonIdempotencyConflict, 409)
	f.ingestor.v2Enabled = true
	different := strings.Replace(string(v2Body(extra)), `"m-1"`, `"m-2"`, 1)
	_, err = f.ingestor.Ingest(context.Background(), f.principal(), f.device, []byte(different), ingMeta())
	ingMustReject(t, err, ReasonSensorForbidden, 403)
	if got := ingCounts(t, f); got != [5]int{1, 1, 1, 1, 1} {
		t.Fatalf("replay/refusal wrote extra rows: %v", got)
	}
}
