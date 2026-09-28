package history

import (
	"context"
	"strings"
	"testing"
	"time"
)

type migrationRows struct {
	found       bool
	replication map[string]string
}

func (r migrationRows) Scan(dest ...any) bool {
	if r.found {
		*dest[0].(*map[string]string) = r.replication
	}
	return r.found
}
func (migrationRows) Close() error { return nil }

type migrationSession struct {
	rows  migrationRows
	execs int
}

func (s *migrationSession) Exec(context.Context, Consistency, string, ...any) error {
	s.execs++
	return nil
}
func (s *migrationSession) Iter(_ context.Context, _ Consistency, stmt string, _ ...any) Rows {
	if strings.Contains(stmt, "system_schema.columns") {
		return &columnRows{names: []string{"co2_ppm", "grain_moisture_percent", "measurement_units", "sensor_observations", "schema_version"}}
	}
	return s.rows
}

func TestMigrateRejectsExistingKeyspaceWithWrongReplication(t *testing.T) {
	cfg := Config{Keyspace: "greenguard_history", Datacenter: "datacenter1", ReplicationFactor: 3}
	for _, tc := range []struct {
		name string
		rows migrationRows
	}{
		{"missing", migrationRows{}},
		{"wrong factor", migrationRows{true, map[string]string{"class": "NetworkTopologyStrategy", "datacenter1": "1"}}},
		{"wrong class", migrationRows{true, map[string]string{"class": "SimpleStrategy", "datacenter1": "3"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			session := &migrationSession{rows: tc.rows}
			if err := Migrate(context.Background(), session, cfg, 24*time.Hour); err == nil || !strings.Contains(err.Error(), "replication mismatch") {
				t.Fatalf("Migrate error = %v", err)
			}
			if session.execs != 1 {
				t.Fatalf("created %d schema objects; want only keyspace attempt", session.execs)
			}
		})
	}
}

func TestMigrateAcceptsRequestedReplication(t *testing.T) {
	cfg := Config{Keyspace: "greenguard_history", Datacenter: "datacenter1", ReplicationFactor: 3}
	session := &migrationSession{rows: migrationRows{true, map[string]string{
		"class": "org.apache.cassandra.locator.NetworkTopologyStrategy", "datacenter1": "3",
	}}}
	if err := Migrate(context.Background(), session, cfg, 24*time.Hour); err != nil {
		t.Fatal(err)
	}
	if session.execs != len(Statements(cfg.Keyspace, cfg.Datacenter, cfg.ReplicationFactor, 24*time.Hour)) {
		t.Fatalf("migration executed %d statements", session.execs)
	}
}
