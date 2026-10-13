package history

import (
	"context"
	"fmt"
)

const insertReadingV2 = `INSERT INTO readings_by_device_day (tenant_id, device_id, day, observed_at, reading_id, event_id, stream_version, received_at, site_id, bin_id, temperature_c, relative_humidity_percent, co2_ppm, grain_moisture_percent, measurement_units, sensor_observations, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) USING TTL ?`
const insertUnboundReadingV2 = `INSERT INTO readings_by_device_day (tenant_id, device_id, day, observed_at, reading_id, event_id, stream_version, received_at, site_id, temperature_c, relative_humidity_percent, co2_ppm, grain_moisture_percent, measurement_units, sensor_observations, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) USING TTL ?`

func (s *Store) writeV2(ctx context.Context, r Reading) error {
	args := []any{r.TenantID, r.DeviceID, Day(r.ObservedAt), r.ObservedAt.UTC(), r.ReadingID, r.EventID, r.StreamVersion, r.ReceivedAt.UTC(), r.SiteID}
	stmt := insertUnboundReadingV2
	if r.BinID != "" {
		stmt = insertReadingV2
		args = append(args, r.BinID)
	}
	var observations any
	if r.SensorObservations != "" {
		observations = r.SensorObservations
	}
	args = append(args, r.TemperatureC, r.RelativeHumidityPercent, r.CO2PPM, r.GrainMoisturePercent, r.MeasurementUnits, observations, 2, int(s.TTL.Seconds()))
	return s.Session.Exec(ctx, LocalQuorum, stmt, args...)
}

// migrateTelemetryV2 upgrades existing cold tables. CREATE IF NOT EXISTS alone
// cannot add columns to an already deployed table. Introspection makes reruns safe.
// Run the owner migrate command once per deployment; schema changes are serialized
// by deployment, and an ALTER failure aborts instead of hiding schema drift.
func migrateTelemetryV2(ctx context.Context, s Session, keyspace string) error {
	columns := map[string]bool{}
	rows := s.Iter(ctx, LocalQuorum, `SELECT column_name FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?`, keyspace, "readings_by_device_day")
	var column string
	for rows.Scan(&column) {
		columns[column] = true
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("read telemetry v2 schema: %w", err)
	}
	for _, definition := range []struct{ name, kind string }{{"co2_ppm", "double"}, {"grain_moisture_percent", "double"}, {"measurement_units", "text"}, {"sensor_observations", "text"}, {"schema_version", "int"}} {
		if columns[definition.name] {
			continue
		}
		if err := s.Exec(ctx, LocalQuorum, fmt.Sprintf("ALTER TABLE %s.readings_by_device_day ADD %s %s", keyspace, definition.name, definition.kind)); err != nil {
			return fmt.Errorf("apply telemetry v2 column %s: %w", definition.name, err)
		}
	}
	return nil
}
