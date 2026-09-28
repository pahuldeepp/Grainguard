package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func referenceEnvelope(kind, device, id string, version int, payload map[string]any) []byte {
	if kind == typeTelemetry {
		if payload["received_at"] == nil {
			payload["received_at"] = payload["observed_at"]
		}
		if payload["source_message_id"] == nil {
			payload["source_message_id"] = id
		}
		if payload["site_id"] == nil {
			payload["site_id"] = "site"
		}
		if payload["measurements"] == nil {
			payload["measurements"] = map[string]any{}
		}
	}
	body, _ := json.Marshal(map[string]any{fieldType: kind, fieldSchema: 1, fieldAggregate: device, fieldEvent: id, fieldVersion: version, fieldPayload: payload})
	return body
}
func TestCanonicalAccumulatorMatchesReferenceAndHistoryCutoff(t *testing.T) {
	d := "11111111-1111-4111-8111-111111111111"
	cutoff := time.Date(2026, 9, 24, 10, 0, 0, 0, time.UTC)
	records := [][]byte{
		referenceEnvelope(typeTelemetry, d, "late", 2, map[string]any{"reading_id": "late-reading", "observed_at": "2026-09-24T11:00:00Z"}),
		referenceEnvelope(typeStatus, d, "status", 3, map[string]any{"status": "offline"}),
		referenceEnvelope(typeTelemetry, d, "old", 1, map[string]any{"reading_id": "old-reading", "observed_at": "2026-09-24T09:00:00Z"}),
		referenceEnvelope(typeRegistered, d, "registered", 1, map[string]any{"site_id": "site", "bin_id": nil, "serial_number": "serial", "status": "online"}),
		referenceEnvelope(typeBinding, d, "binding", 2, map[string]any{"site_id": "new-site", "bin_id": "new-bin"}),
	}
	acc := newCanonicalAccumulator(cutoff)
	for _, body := range records {
		raw, err := decode(body)
		if err != nil {
			t.Fatal(err)
		}
		if err := acc.add(raw.(map[string]any)); err != nil {
			t.Fatal(err)
		}
	}
	got := acc.finish()
	want, err := referenceFoldAt(records, cutoff)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("stream fold differs: got %+v want %+v", got, want)
	}
	if len(got.Readings) != 1 || got.Readings["late-reading"].Event != "late" {
		t.Fatal("history cutoff not applied", got.Readings)
	}
}
func TestReferenceFoldIndependentOrderingAndGaps(t *testing.T) {
	d := "11111111-1111-4111-8111-111111111111"
	records := [][]byte{
		referenceEnvelope(typeStatus, d, "status", 3, map[string]any{"status": "offline"}),
		referenceEnvelope(typeRegistered, d, "registered", 1, map[string]any{"site_id": "site", "bin_id": nil, "serial_number": "serial", "status": "online"}),
		referenceEnvelope(typeTelemetry, d, "newer-version", 2, map[string]any{"reading_id": "reading-2", "observed_at": "2026-09-24T10:00:00Z"}),
		referenceEnvelope(typeTelemetry, d, "newer-time", 1, map[string]any{"reading_id": "reading-1", "observed_at": "2026-09-24T11:00:00Z"}),
	}
	state, err := referenceFold(records)
	if err != nil {
		t.Fatal(err)
	}
	if got := state.Devices[d]; got.Version != 1 || got.Status != "online" {
		t.Fatalf("unexpected device with inventory gap: %+v", got)
	}
	if got := state.Streams[d+"/inventory"]; !reflect.DeepEqual(got.Gaps, [][2]int64{{2, 2}}) || got.Contiguous != 1 {
		t.Fatalf("wrong gap: %+v", got)
	}
	if got := state.Latest[d]; got.Reading != "reading-1" || got.Selected != 1 || got.Max != 2 || got.Contiguous != 2 {
		t.Fatalf("wrong latest: %+v", got)
	}
	if len(state.Readings) != 2 || state.Readings["reading-1"].Event != "newer-time" || state.Readings["reading-1"].Enrichment != "applied" {
		t.Fatalf("wrong history reference: %+v", state.Readings)
	}
	if len(state.Notifications) != 4 || state.Notifications["newer-time"] != d {
		t.Fatalf("wrong notification reference: %+v", state.Notifications)
	}
	state, err = referenceFold(append(records, referenceEnvelope(typeBinding, d, "binding", 2, map[string]any{"site_id": "new-site", "bin_id": "new-bin"})))
	if err != nil {
		t.Fatal(err)
	}
	if got := state.Devices[d]; got.Version != 3 || got.Site != "new-site" || got.Bin != "new-bin" || got.Status != "offline" {
		t.Fatalf("wrong contiguous fold: %+v", got)
	}
}
func TestReferenceFoldRejectsAmbiguousVersion(t *testing.T) {
	d := "11111111-1111-4111-8111-111111111111"
	e := referenceEnvelope(typeStatus, d, "one", 1, map[string]any{"status": "online"})
	if _, err := referenceFold([][]byte{e, e}); err == nil {
		t.Fatal("ambiguous stream version accepted")
	}
}

func TestCanonicalLayoutSensorsIgnoresOrderAndNormalizesDepth(t *testing.T) {
	first := map[string]any{"sensor_id": "sensor-a", "position": json.Number("1"), "label": "Top", "depth_m": nil}
	second := map[string]any{"sensor_id": "sensor-b", "position": json.Number("2"), "label": "Bottom", "depth_m": json.Number("3.5")}
	forward, err := canonicalLayoutSensors([]any{first, second})
	if err != nil {
		t.Fatal(err)
	}
	reversed, err := canonicalLayoutSensors([]any{second, first})
	if err != nil {
		t.Fatal(err)
	}
	if forward != reversed {
		t.Fatalf("sensor order affected canonical layout: %s != %s", forward, reversed)
	}
	if !strings.Contains(forward, `"depth_m":null`) {
		t.Fatalf("missing depth was not normalized to null: %s", forward)
	}
}
