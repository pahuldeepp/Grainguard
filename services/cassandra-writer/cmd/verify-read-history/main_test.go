package main

import (
	"testing"

	"greenguard.local/cassandra-writer/history"
)

func TestCompareCassandraGroupRequiresExactReadingAndSensorCoverage(t *testing.T) {
	group := &deviceDay{
		tenantID: "tenant-1", deviceID: "device-1",
		rows: map[string]expectedReading{
			"reading-1": {eventID: "event-1", sensors: []string{`{"name":"temperature","value":28}`}},
		},
	}
	complete := []history.Identity{{
		ReadingID: "reading-1", EventID: "event-1",
		SensorObservations: `[{"name":"temperature","value":28}]`,
	}}
	if err := compareCassandraGroup(group, complete); err != nil {
		t.Fatalf("complete Cassandra copy rejected: %v", err)
	}

	tests := []struct {
		name string
		rows []history.Identity
	}{
		{name: "missing reading", rows: nil},
		{name: "wrong event", rows: []history.Identity{{ReadingID: "reading-1", EventID: "event-old", SensorObservations: `[{"name":"temperature","value":28}]`}}},
		{name: "wrong sensors", rows: []history.Identity{{ReadingID: "reading-1", EventID: "event-1", SensorObservations: `[{"name":"temperature","value":29}]`}}},
		{name: "extra Cassandra reading", rows: append(append([]history.Identity{}, complete...), history.Identity{ReadingID: "reading-extra", EventID: "event-extra"})},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := compareCassandraGroup(group, test.rows); err == nil {
				t.Fatal("unsafe Cassandra coverage was accepted")
			}
		})
	}
}

func TestCanonicalSensorJSONRejectsMalformedRows(t *testing.T) {
	if _, err := canonicalSensorJSON(`{"name":"temperature"}`); err == nil {
		t.Fatal("non-array sensor data must not count as coverage")
	}
}
