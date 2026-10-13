package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
	"greenguard.local/cassandra-writer/history"
)

// backfillReadHistory repairs old Cassandra history from the immutable
// canonical events retained in the projection inbox. It never writes coverage
// receipts or prunes PostgreSQL; the independent verifier must prove the copy.
func backfillReadHistory(ctx context.Context, getenv func(string) string) error {
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
	pg, err := pgxpool.NewWithConfig(ctx, pgConfig)
	if err != nil {
		return errors.New("connect to PostgreSQL read model")
	}
	defer pg.Close()

	window, err := history.HotWindow(getenv)
	if err != nil {
		return err
	}
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
	ttl, err := history.TTL(getenv)
	if err != nil {
		return err
	}
	store := &history.Store{Session: cassandra, TTL: ttl}
	schemaDir := strings.TrimSpace(getenv("EVENT_SCHEMA_DIR"))
	if schemaDir == "" {
		schemaDir = "../../contracts/events"
	}
	schema, err := loadSchema(schemaDir)
	if err != nil {
		return err
	}

	var candidates []string
	rows, err := pg.Query(ctx, "SELECT partition_name FROM projection_history_cassandra_candidates($1::double precision)", window.Seconds())
	if err != nil {
		return fmt.Errorf("list Cassandra repair candidates: %w", err)
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

	var written int64
	for _, partition := range candidates {
		var expected int64
		if err = pg.QueryRow(ctx, "SELECT reading_rows FROM projection_history_partition_counts($1)", partition).Scan(&expected); err != nil {
			return fmt.Errorf("count partition %s: %w", partition, err)
		}
		events, queryErr := pg.Query(ctx, "SELECT event FROM projection_history_cassandra_repair_events($1,$2::double precision)", partition, window.Seconds())
		if queryErr != nil {
			return fmt.Errorf("read canonical repair events for %s: %w", partition, queryErr)
		}
		var partitionRows int64
		for events.Next() {
			var raw []byte
			if err = events.Scan(&raw); err != nil {
				events.Close()
				return err
			}
			event, ok := decode(raw)
			if !ok {
				events.Close()
				return fmt.Errorf("canonical event in %s is invalid JSON", partition)
			}
			version := fmt.Sprint(event[fieldSchema])
			topic := topicTelemetry
			if version == "2" {
				topic = topicTelemetryV2
			} else if version != "1" {
				events.Close()
				return fmt.Errorf("canonical event in %s has unsupported schema version", partition)
			}
			key := []byte(fmt.Sprint(event[fieldTenant]) + ":" + fmt.Sprint(event[fieldAggregate]))
			message := Message{Topic: topic, Key: key, Value: raw, Headers: []kgo.RecordHeader{
				{Key: fieldTenant, Value: []byte(fmt.Sprint(event[fieldTenant]))},
				{Key: fieldEvent, Value: []byte(fmt.Sprint(event[fieldEvent]))},
				{Key: fieldType, Value: []byte(fmt.Sprint(event[fieldType]))},
				{Key: fieldSchema, Value: []byte(version)},
			}}
			reading, _, reason := parse(schema, message)
			if reason != "" {
				events.Close()
				return fmt.Errorf("canonical event in %s failed Cassandra-writer validation (%s)", partition, reason)
			}
			if history.Day(reading.ObservedAt).Format("20060102") != strings.TrimPrefix(partition, "reading_history_") {
				events.Close()
				return fmt.Errorf("canonical event timestamp does not belong to %s", partition)
			}
			if err = store.Write(ctx, reading); err != nil {
				events.Close()
				return fmt.Errorf("write canonical event into Cassandra for %s: %w", partition, err)
			}
			partitionRows++
		}
		if err = events.Err(); err != nil {
			events.Close()
			return err
		}
		events.Close()
		if partitionRows != expected {
			return fmt.Errorf("repair source coverage mismatch for %s: found %d canonical events for %d readings", partition, partitionRows, expected)
		}
		written += partitionRows
		slog.Info("replayed canonical events into Cassandra", "partition", partition, "rows", partitionRows)
	}
	slog.Info("Cassandra read-history repair finished; run verify-read-history before maintenance", "candidate_partitions", len(candidates), "rows_written", written)
	return nil
}
