package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const fixtureRoot = "../../tests/fixtures/events"
const schemaRoot = "../../contracts/events"

func read(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func eventFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	value, err := decode(read(t, filepath.Join(fixtureRoot, name)))
	if err != nil {
		t.Fatal(err)
	}
	return value.(map[string]any)
}
func testSchemas(t *testing.T) schemas {
	t.Helper()
	s, err := loadSchemas(schemaRoot)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func validEvent(t *testing.T) map[string]any {
	return eventFixture(t, "telemetry-recorded.v1.valid.json")
}
func rawEvent(t *testing.T, event map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]any{fieldPayload: map[string]any{"op": "c", "source": map[string]any{"table": "outbox_events"}, "after": event}})
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func requireReason(t *testing.T, got *failure, want string) {
	t.Helper()
	if want == "" {
		if got != nil {
			t.Fatal(got)
		}
		return
	}
	if got == nil || got.Reason != want {
		t.Fatalf("got %v, want %s", got, want)
	}
	if !strings.Contains(got.Error(), want) {
		t.Fatal("error omitted reason")
	}
}

func TestCrossLanguageFixtureParity(t *testing.T) {
	s := testSchemas(t)
	var expectations map[string]bool
	if err := json.Unmarshal(read(t, filepath.Join(fixtureRoot, "expectations.json")), &expectations); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(read(t, filepath.Join(fixtureRoot, "telemetry-identity.expectations.json")), &expectations); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(read(t, filepath.Join(fixtureRoot, "facility.expectations.json")), &expectations); err != nil {
		t.Fatal(err)
	}
	paths, _ := filepath.Glob(filepath.Join(fixtureRoot, "*.v1.valid.json"))
	// This shared expectation manifest covers the original inventory and
	// telemetry fixtures. Stage 06 fixtures have their own routing tests.
	owned := make(map[string]bool, len(schemaFiles))
	for key, file := range schemaFiles {
		if strings.HasPrefix(key, "risk.") || strings.HasPrefix(key, "alert.") {
			continue
		}
		owned[file[:len(file)-len(".schema.json")]+".valid.json"] = true
	}
	var sourceFixtures []string
	for _, path := range paths {
		if owned[filepath.Base(path)] {
			sourceFixtures = append(sourceFixtures, path)
		}
	}
	paths = sourceFixtures
	invalid, _ := filepath.Glob(filepath.Join(fixtureRoot, "invalid", "*.json"))
	paths = append(paths, invalid...)
	if len(paths) != len(expectations) {
		t.Fatal("every shared fixture needs a recorded verdict")
	}
	for _, path := range paths {
		name, _ := filepath.Rel(fixtureRoot, path)
		t.Run(name, func(t *testing.T) {
			want, ok := expectations[name]
			if !ok {
				t.Fatal("unrecorded fixture")
			}
			got := s.Validate(eventFixture(t, name))
			if (got == nil) != want {
				t.Fatalf("expected accepted=%v: %v", want, got)
			}
		})
	}
}

func TestRawGoldenFixturesAndDuplicateIdentity(t *testing.T) {
	s := testSchemas(t)
	var cases []struct{ File, Topic, Reason, Ignored, Canonical string }
	if err := json.Unmarshal(read(t, filepath.Join(fixtureRoot, "raw", "expectations.json")), &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.File, func(t *testing.T) { checkRawGolden(t, s, tc.File, tc.Topic, tc.Reason, tc.Ignored, tc.Canonical) })
	}
}

func checkRawGolden(t *testing.T, s SchemaSet, file, topic, reason, ignoredWant, canonical string) {
	m := Message{Topic: topic, Value: read(t, filepath.Join(fixtureRoot, "raw", file))}
	first, ignored, err := transform(m, s)
	requireReason(t, err, reason)
	if ignored != ignoredWant {
		t.Fatalf("ignored=%s", ignored)
	}
	if canonical == "" {
		return
	}
	want := bytes.TrimSpace(read(t, filepath.Join(fixtureRoot, "raw", canonical)))
	if !bytes.Equal(first.Value, want) {
		t.Fatalf("got %s\nwant %s", first.Value, want)
	}
	second, _, err := transform(m, s)
	requireReason(t, err, "")
	if !bytes.Equal(first.Value, second.Value) || first.Headers[fieldEvent] != second.Headers[fieldEvent] {
		t.Fatal("duplicate changed event")
	}
	original := eventFixture(t, filepath.Join("raw", canonical))
	if first.Headers[fieldEvent] != original[fieldEvent] {
		t.Fatal("regenerated ID")
	}
}

func TestUnwrapInvalidAndIgnored(t *testing.T) {
	for _, tc := range []struct{ raw, reason, ignored string }{
		{"", reasonEnvelope, ""}, {"null", "", opTombstone}, {"[]", reasonEnvelope, ""}, {"null {}", reasonEnvelope, ""},
		{"{}", reasonEnvelope, ""}, {`{"payload":null}`, reasonEnvelope, ""}, {`{"op":3}`, reasonEnvelope, ""},
		{`{"op":""}`, reasonEnvelope, ""}, {`{"op":"c"}`, reasonEnvelope, ""},
		{`{"op":"c","source":{"table":"readings"},"after":{}}`, reasonEnvelope, ""},
		{`{"op":"r","source":{"table":"outbox_events"},"after":null}`, reasonEnvelope, ""},
		{`{"op":"u"}`, "", "u"}, {`{"op":"d"}`, "", "d"}, {`{"op":"t"}`, reasonOp, ""},
		{`{"op":"c","source":{"table":"outbox_events"},"after":{}}`, "", ""},
	} {
		_, ignored, err := unwrap([]byte(tc.raw))
		requireReason(t, err, tc.reason)
		if ignored != tc.ignored {
			t.Fatal(ignored)
		}
	}
	for _, text := range []string{`{} {}`, `{} broken`, `{} []`} {
		if _, err := decode([]byte(text)); err == nil {
			t.Fatal(text)
		}
	}
}

func TestMappingFailuresAndTypes(t *testing.T) {
	for _, tc := range []struct {
		key    string
		value  any
		reason string
	}{
		{fieldTenant, nil, reasonMissing}, {fieldVersion, true, reasonBigint}, {fieldVersion, "01", reasonBigint},
		{fieldOccurred, true, reasonTimestamp}, {fieldOccurred, "2026-09-21T00:00:00.1234567Z", reasonTimestamp},
		{fieldOccurred, json.Number("1.2"), reasonTimestamp}, {fieldOccurred, json.Number("9223372036854775807"), reasonTimestamp},
		{fieldPayload, "{", reasonSchema},
	} {
		e := validEvent(t)
		e[tc.key] = tc.value
		_, err := mapRow(e)
		requireReason(t, err, tc.reason)
	}
	for _, v := range []any{"0", "-1", "+1", "9223372036854775808", json.Number("1.5")} {
		_, err := bigint(v)
		requireReason(t, err, reasonBigint)
	}
	for _, v := range []any{"9007199254740993", json.Number("9223372036854775807")} {
		_, err := bigint(v)
		requireReason(t, err, "")
	}
	for _, v := range []any{"2026-09-21T16:00:00.125+01:00", json.Number("1790002800125000")} {
		got, err := occurredAt(v)
		requireReason(t, err, "")
		if got != "2026-09-21T15:00:00.125000Z" {
			t.Fatal(got)
		}
	}
}

func TestTenantAndSourceIsolation(t *testing.T) {
	s := testSchemas(t)
	e := validEvent(t)
	for _, tenant := range []any{nil, "not-a-uuid", "00000000-0000-0000-0000-000000000000"} {
		e[fieldTenant] = tenant
		record, _, err := transform(Message{Topic: rawTelemetry, Value: rawEvent(t, e)}, s)
		if err == nil || len(record.Value) > 0 {
			t.Fatal("tenant-less event escaped")
		}
	}
	e = validEvent(t)
	for _, topic := range []string{"readings", rawInventory} {
		_, _, err := transform(Message{Topic: topic, Value: rawEvent(t, e)}, s)
		requireReason(t, err, reasonEnvelope)
	}
	original := e[fieldTenant]
	e[fieldTenant] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	record, _, err := transform(Message{Topic: rawTelemetry, Value: rawEvent(t, e)}, s)
	requireReason(t, err, "")
	if strings.Contains(string(record.Key), original.(string)) || record.Headers[fieldTenant] != e[fieldTenant] {
		t.Fatal("tenant leaked between rows")
	}
}

func TestSchemaFormatsAndSemanticLimits(t *testing.T) {
	s := testSchemas(t)
	for _, timestamp := range []string{"2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z"} {
		e := validEvent(t)
		e[fieldOccurred] = timestamp
		requireReason(t, s.Validate(e), reasonSchema)
	}
	e := validEvent(t)
	e[fieldVersion] = "9223372036854775807"
	requireReason(t, s.Validate(e), "")
	if _, err := loadSchemas(t.TempDir()); err == nil {
		t.Fatal("missing schema accepted")
	}
}

func TestQuarantineBoundedBytes(t *testing.T) {
	for _, size := range []int{3, maxRawBytes, maxRawBytes + 1} {
		raw := bytes.Repeat([]byte{0xff}, size)
		record := quarantineRecord(Message{Topic: rawTelemetry, Partition: 3, Offset: 42, Value: raw}, fail(reasonEnvelope, "invalid JSON"))
		var q quarantine
		if err := json.Unmarshal(record.Value, &q); err != nil {
			t.Fatal(err)
		}
		if len(q.Raw) != min(size, maxRawBytes) || q.Truncated != (size > maxRawBytes) || !bytes.Equal(q.Raw, raw[:len(q.Raw)]) {
			t.Fatal("lost raw bytes")
		}
		if q.Partition != 3 || q.Offset != 42 || record.Headers["source_offset"] != "42" {
			t.Fatal("lost source coordinates")
		}
	}
}

func TestAllRequiredColumnsAndEnvelopeMetadataCannotSupplyTenant(t *testing.T) {
	for _, field := range fields {
		row := validEvent(t)
		delete(row, field)
		_, err := mapRow(row)
		requireReason(t, err, reasonMissing)
	}
	raw := rawEvent(t, validEvent(t))
	value, err := decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	envelope := value.(map[string]any)[fieldPayload].(map[string]any)
	row := envelope["after"].(map[string]any)
	envelope["source"].(map[string]any)[fieldTenant] = row[fieldTenant]
	delete(row, fieldTenant)
	raw, err = json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	_, _, invalid := transform(Message{Topic: rawTelemetry, Value: raw}, testSchemas(t))
	requireReason(t, invalid, reasonMissing)
}

func TestTimestampAndMeasurementEdges(t *testing.T) {
	for _, value := range []any{"2026-09-21T15:00:00.0000000001Z", "2026-09-21T15:00:00.0000000Z", json.Number("-9223372036854775808")} {
		_, err := occurredAt(value)
		requireReason(t, err, reasonTimestamp)
	}
	s := testSchemas(t)
	event := validEvent(t)
	event[fieldPayload].(map[string]any)["measurements"].(map[string]any)["temperature_c"] = json.Number("1e999")
	requireReason(t, s.Validate(event), reasonSchema)
	for _, value := range []any{json.Number("-1"), "1969-12-31T23:59:59.999999Z"} {
		timestamp, err := occurredAt(value)
		requireReason(t, err, "")
		if timestamp != "1969-12-31T23:59:59.999999Z" {
			t.Fatal(timestamp)
		}
	}
	_, _, invalid := transform(Message{Topic: rawTelemetry, Value: []byte("   ")}, s)
	requireReason(t, invalid, reasonEnvelope)
}

func TestTelemetryIdentityMismatchCannotBePublished(t *testing.T) {
	event := eventFixture(t, "invalid/telemetry-device-id-differs-from-aggregate-id.json")
	record, ignored, err := transform(Message{Topic: rawTelemetry, Value: rawEvent(t, event)}, testSchemas(t))
	requireReason(t, err, reasonSchema)
	if len(record.Value) != 0 || ignored != "" {
		t.Fatal("mismatched telemetry must be quarantined, not published or ignored")
	}
}
