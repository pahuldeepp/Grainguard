package history

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"
)

type columnRows struct {
	names []string
	index int
}

func (r *columnRows) Scan(dest ...any) bool {
	if r.index == len(r.names) {
		return false
	}
	*(dest[0].(*string)) = r.names[r.index]
	r.index++
	return true
}
func (*columnRows) Close() error { return nil }

type upgradeSession struct {
	columns    []string
	statements []string
}

func (s *upgradeSession) Iter(context.Context, Consistency, string, ...any) Rows {
	return &columnRows{names: s.columns}
}
func (s *upgradeSession) Exec(_ context.Context, _ Consistency, statement string, _ ...any) error {
	s.statements = append(s.statements, statement)
	return nil
}

func TestAdditiveTelemetryMigrationUpgradesExistingColdTableAndReruns(t *testing.T) {
	s := &upgradeSession{}
	if err := migrateTelemetryV2(context.Background(), s, "gg_history"); err != nil {
		t.Fatal(err)
	}
	if len(s.statements) != 5 {
		t.Fatal(s.statements)
	}
	for _, statement := range s.statements {
		if !strings.HasPrefix(statement, "ALTER TABLE gg_history.readings_by_device_day ADD ") {
			t.Fatal(statement)
		}
	}
	s.columns = []string{"co2_ppm", "grain_moisture_percent", "measurement_units", "sensor_observations", "schema_version"}
	s.statements = nil
	if err := migrateTelemetryV2(context.Background(), s, "gg_history"); err != nil || len(s.statements) != 0 {
		t.Fatalf("rerun %v %v", s.statements, err)
	}
}

func TestV2ColdReplayUsesIdenticalPrimaryKeyAndSparseValues(t *testing.T) {
	session := &captureSession{}
	store := Store{Session: session, TTL: time.Hour}
	co2 := 450.0
	r := Reading{TenantID: "11111111-1111-4111-8111-111111111111", DeviceID: "33333333-3333-4333-8333-333333333333", ReadingID: "bb70cd06-0720-461a-8ecf-a56754985f87", EventID: "0d72ff07-a646-4d41-9b5b-52c5f25e4ca8", ObservedAt: time.Now(), ReceivedAt: time.Now(), SchemaVersion: 2, CO2PPM: &co2, MeasurementUnits: `{"co2_ppm":"ppm"}`, SensorObservations: `[{"sensor_id":"77777777-7777-4777-8777-777777777777","metric":"co2_ppm","value":450,"unit":"ppm"}]`}
	if err := store.Write(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	stmt, args := session.stmt, append([]any(nil), session.args...)
	if stmt != insertUnboundReadingV2 || len(args) != 17 || args[9] != r.TemperatureC || args[10] != r.RelativeHumidityPercent || args[12] != r.GrainMoisturePercent {
		t.Fatalf("sparse write %s %v", stmt, args)
	}
	if err := store.Write(context.Background(), r); err != nil || session.stmt != stmt || !reflect.DeepEqual(args, session.args) {
		t.Fatalf("replay changed write %v", err)
	}
	r.TenantID = "invalid"
	if err := store.Write(context.Background(), r); err != ErrInvalidTenant {
		t.Fatalf("tenant=%v", err)
	}
}
