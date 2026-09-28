package history

import (
	"context"
	"fmt"
	"strconv"
	"time"
)

// Statements returns the idempotent schema for one keyspace. Every statement
// uses IF NOT EXISTS, so rerunning the migration is a no-op. The table TTL is
// a default only; writes set USING TTL explicitly from HISTORY_TTL.
func Statements(keyspace, datacenter string, rf int, ttl time.Duration) []string {
	return []string{
		fmt.Sprintf(`CREATE KEYSPACE IF NOT EXISTS %s WITH replication = {'class': 'NetworkTopologyStrategy', '%s': %d}`, keyspace, datacenter, rf),
		fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s.readings_by_device_day (
  tenant_id uuid, device_id uuid, day date,
  observed_at timestamp, reading_id uuid,
  event_id uuid, stream_version bigint, received_at timestamp,
  site_id uuid, bin_id uuid,
  temperature_c double, relative_humidity_percent double,
  co2_ppm double, grain_moisture_percent double, measurement_units text, sensor_observations text, schema_version int,
  PRIMARY KEY ((tenant_id, device_id, day), observed_at, reading_id)
) WITH CLUSTERING ORDER BY (observed_at DESC, reading_id ASC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy', 'compaction_window_unit': 'DAYS', 'compaction_window_size': 1}
  AND default_time_to_live = %d`, keyspace, int(ttl.Seconds())),
		fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s.history_watermark (
  tenant_id uuid, device_id uuid, source_topic text, source_partition int,
  last_confirmed_offset bigint, last_confirmed_observed_at timestamp, updated_at timestamp,
  PRIMARY KEY ((tenant_id, device_id), source_topic, source_partition)
)`, keyspace),
	}
}

// Migrate applies Statements through a session that is not bound to the
// keyspace (it may not exist yet).
func Migrate(ctx context.Context, s Session, cfg Config, ttl time.Duration) error {
	statements := Statements(cfg.Keyspace, cfg.Datacenter, cfg.ReplicationFactor, ttl)
	for index, stmt := range statements {
		if err := s.Exec(ctx, LocalQuorum, stmt); err != nil {
			return fmt.Errorf("apply history schema: %w", err)
		}
		if index == 0 {
			rows := s.Iter(ctx, LocalQuorum, `SELECT replication FROM system_schema.keyspaces WHERE keyspace_name = ?`, cfg.Keyspace)
			var replication map[string]string
			found := rows.Scan(&replication)
			if err := rows.Close(); err != nil {
				return fmt.Errorf("read history keyspace replication: %w", err)
			}
			class := replication["class"]
			validClass := class == "NetworkTopologyStrategy" || class == "org.apache.cassandra.locator.NetworkTopologyStrategy"
			if !found || !validClass || replication[cfg.Datacenter] != strconv.Itoa(cfg.ReplicationFactor) {
				return fmt.Errorf("history keyspace %s replication mismatch: got %v, want NetworkTopologyStrategy %s=%d", cfg.Keyspace, replication, cfg.Datacenter, cfg.ReplicationFactor)
			}
		}
	}
	return migrateTelemetryV2(ctx, s, cfg.Keyspace)
}

// OpenSystem connects without a keyspace for migrations.
func OpenSystem(c Config) (*CQLSession, error) {
	session, err := c.Cluster("").CreateSession()
	if err != nil {
		return nil, fmt.Errorf("connect cassandra: %w", err)
	}
	return &CQLSession{session: session}, nil
}
