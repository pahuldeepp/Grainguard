// Command verify-read-history compares every row in an expired PostgreSQL
// read-history partition with its tenant/device/day Cassandra partition. It
// records a proof receipt only after all expected reading/event identities are
// present in Cassandra. The read-model maintenance job consumes that receipt.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"greenguard.local/cassandra-writer/history"
)

type expectedReading struct {
	eventID string
	sensors []string
}
type deviceDay struct {
	tenantID string
	deviceID string
	rows     map[string]expectedReading
}

func run(ctx context.Context, getenv func(string) string) error {
	window, err := history.HotWindow(getenv)
	if err != nil {
		return err
	}
	pgURL := strings.TrimSpace(getenv("PROJECTION_MAINTENANCE_URL"))
	parsed, err := url.Parse(pgURL)
	if err != nil || parsed == nil || parsed.User == nil || parsed.User.Username() != "projection_history_maintainer" || parsed.Path != "/greenguard_read" {
		return errors.New("maintenance URL must use projection_history_maintainer in greenguard_read")
	}
	pgConfig, err := pgxpool.ParseConfig(pgURL)
	if err != nil {
		return errors.New("invalid maintenance database configuration")
	}
	pgConfig.MaxConns = 2
	pgConfig.ConnConfig.RuntimeParams["timezone"] = "UTC"
	pg, err := pgxpool.NewWithConfig(ctx, pgConfig)
	if err != nil {
		return errors.New("connect to PostgreSQL read model")
	}
	defer pg.Close()

	cfg, err := history.LoadConfig(getenv)
	if err != nil {
		return err
	}
	cassandra, err := history.Open(cfg)
	if err != nil {
		return err
	}
	defer cassandra.Close()
	if err = cassandra.Ping(ctx); err != nil {
		return errors.New("Cassandra history is unavailable")
	}

	var candidates []string
	rows, err := pg.Query(ctx, "SELECT partition_name FROM projection_history_cassandra_candidates($1::double precision)", window.Seconds())
	if err != nil {
		return fmt.Errorf("list Cassandra coverage candidates: %w", err)
	}
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		candidates = append(candidates, name)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, partition := range candidates {
		if err = verifyPartition(ctx, pg, cassandra, partition, window); err != nil {
			return fmt.Errorf("verify partition %s: %w", partition, err)
		}
	}
	slog.Info("Cassandra read-history coverage verified", "candidate_partitions", len(candidates))
	return nil
}

func verifyPartition(ctx context.Context, pg *pgxpool.Pool, cassandra *history.CQLSession, partition string, window time.Duration) error {
	var expectedRows, sensorRows int64
	if err := pg.QueryRow(ctx, "SELECT reading_rows,sensor_rows FROM projection_history_partition_counts($1)", partition).Scan(&expectedRows, &sensorRows); err != nil {
		return err
	}
	rows, err := pg.Query(ctx, "SELECT tenant_id::text,device_id::text,observed_at,reading_id::text,event_id::text,sensor_observations::text,to_jsonb(m)::text FROM projection_history_cassandra_manifest($1) m", partition)
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte("greenguard-history-manifest-v2\n"))
	var counted, countedSensors int64
	var current *deviceDay
	day, err := time.Parse("20060102", strings.TrimPrefix(partition, "reading_history_"))
	if err != nil {
		rows.Close()
		return errors.New("invalid UTC partition name")
	}
	flush := func(group *deviceDay) error {
		if group == nil {
			return nil
		}
		cold, readErr := (&history.Store{Session: cassandra}).DayIdentities(ctx, group.tenantID, group.deviceID, day)
		if readErr != nil {
			return readErr
		}
		return compareCassandraGroup(group, cold)
	}
	for rows.Next() {
		var tenantID, deviceID, readingID, eventID, sensorsJSON, manifestJSON string
		var observedAt time.Time
		if err = rows.Scan(&tenantID, &deviceID, &observedAt, &readingID, &eventID, &sensorsJSON, &manifestJSON); err != nil {
			rows.Close()
			return err
		}
		key := tenantID + "/" + deviceID
		if current == nil || current.tenantID+"/"+current.deviceID != key {
			if err = flush(current); err != nil {
				rows.Close()
				return err
			}
			current = &deviceDay{tenantID: tenantID, deviceID: deviceID, rows: make(map[string]expectedReading)}
		}
		if previous, exists := current.rows[readingID]; exists {
			rows.Close()
			return fmt.Errorf("duplicate projected reading identity %s (events %s and %s)", readingID, previous.eventID, eventID)
		}
		sensors, parseErr := canonicalSensorJSON(sensorsJSON)
		if parseErr != nil {
			rows.Close()
			return fmt.Errorf("decode PostgreSQL sensor observations for reading %s: %w", readingID, parseErr)
		}
		current.rows[readingID] = expectedReading{eventID: eventID, sensors: sensors}
		countedSensors += int64(len(sensors))
		digest = sha256.Sum256(append(digest[:], []byte(manifestJSON+"\n")...))
		counted++
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if err = flush(current); err != nil {
		return err
	}
	if counted != expectedRows {
		return fmt.Errorf("manifest row count changed: got %d want %d", counted, expectedRows)
	}
	if countedSensors != sensorRows {
		return fmt.Errorf("sensor manifest row count changed: got %d want %d", countedSensors, sensorRows)
	}
	_, err = pg.Exec(ctx, "SELECT projection_history_record_cassandra_coverage($1,$2,$3,$4,$5::double precision)", partition, expectedRows, sensorRows, fmt.Sprintf("%x", digest), window.Seconds())
	return err
}

func compareCassandraGroup(group *deviceDay, coldRows []history.Identity) error {
	cold := make(map[string]history.Identity, len(coldRows))
	for _, row := range coldRows {
		if existing, duplicate := cold[row.ReadingID]; duplicate && (existing.EventID != row.EventID || existing.SensorObservations != row.SensorObservations) {
			return fmt.Errorf("Cassandra contains conflicting replay for reading %s", row.ReadingID)
		}
		cold[row.ReadingID] = row
	}
	for readingID, expected := range group.rows {
		row, found := cold[readingID]
		if !found || row.EventID != expected.eventID {
			return fmt.Errorf("Cassandra is missing reading/event identity %s/%s for %s/%s", readingID, expected.eventID, group.tenantID, group.deviceID)
		}
		got, err := canonicalSensorJSON(row.SensorObservations)
		if err != nil {
			return fmt.Errorf("decode Cassandra sensor observations for reading %s: %w", readingID, err)
		}
		if !sameStrings(got, expected.sensors) {
			return fmt.Errorf("Cassandra sensor observations differ from PostgreSQL projection for reading %s", readingID)
		}
	}
	for readingID := range cold {
		if _, exists := group.rows[readingID]; !exists {
			return fmt.Errorf("Cassandra contains unprojected reading identity %s for %s/%s", readingID, group.tenantID, group.deviceID)
		}
	}
	return nil
}

func canonicalSensorJSON(raw string) ([]string, error) {
	if raw == "" || raw == "null" {
		return nil, nil
	}
	var values []map[string]any
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil, err
	}
	canonical := make([]string, 0, len(values))
	for _, value := range values {
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		canonical = append(canonical, string(encoded))
	}
	sort.Strings(canonical)
	return canonical, nil
}

func sameStrings(a, b []string) bool {
	sort.Strings(a)
	sort.Strings(b)
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := run(ctx, os.Getenv); err != nil {
		slog.Error("Cassandra history verification failed; partition pruning remains blocked", "error", err)
		os.Exit(1)
	}
}
