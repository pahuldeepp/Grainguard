package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"io"
	"strconv"
	"time"
)

const bindingHeartbeatKey = "binding-feed-checkpoint"
const bindingHeartbeat = "binding.feed_checkpoint"
const infrastructureTenant = "00000000-0000-4000-8000-000000000001"

var ErrCheckpoint = errors.New("invalid feed checkpoint")

type FeedCheckpoint struct {
	EventType      string    `json:"event_type"`
	SchemaVersion  int       `json:"schema_version"`
	SourceTime     time.Time `json:"source_time"`
	SourcePosition string    `json:"source_position"`
	RawPosition    int64     `json:"raw_position"`
	Partitions     int       `json:"partitions"`
}

func parseCheckpoint(m Message, partitions int) (FeedCheckpoint, error) {
	var cp FeedCheckpoint
	decoder := json.NewDecoder(bytes.NewReader(m.Value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cp); err != nil {
		return cp, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return cp, ErrCheckpoint
	}
	if m.Topic != topicInventory || string(m.Key) != bindingHeartbeatKey || cp.EventType != bindingHeartbeat || cp.SchemaVersion != 1 {
		return cp, ErrCheckpoint
	}
	if cp.SourceTime.IsZero() || cp.RawPosition < 0 || cp.SourcePosition == "" || len(cp.SourcePosition) > 128 {
		return cp, ErrCheckpoint
	}
	if position, err := strconv.ParseUint(cp.SourcePosition, 10, 64); err != nil || position == 0 {
		return cp, ErrCheckpoint
	}
	if cp.Partitions != partitions || m.Partition < 0 || int(m.Partition) >= partitions || m.Offset < 0 {
		return cp, ErrCheckpoint
	}
	return cp, nil
}

func (s *Store) Heartbeat(ctx context.Context, m Message) error {
	cp, err := parseCheckpoint(m, 6)
	if err != nil {
		return ErrCheckpoint
	}
	cp.SourceTime = minTime(cp.SourceTime, time.Now())
	schema := s.Schema
	if schema == "" {
		schema = "public"
	}
	return WithTenantSchema(ctx, s.DB, infrastructureTenant, schema, func(ctx context.Context, tx pgx.Tx) error {
		if err := s.Lease.check(ctx, tx); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO projection_checkpoints(tenant_id,consumer_name,topic,partition,committed_offset,source_time,source_position,raw_position,partition_count)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,consumer_name,topic,partition) DO UPDATE SET committed_offset=EXCLUDED.committed_offset,source_time=EXCLUDED.source_time,source_position=EXCLUDED.source_position,raw_position=EXCLUDED.raw_position,partition_count=EXCLUDED.partition_count,last_projected_at=clock_timestamp()
 WHERE projection_checkpoints.committed_offset<EXCLUDED.committed_offset AND projection_checkpoints.raw_position<EXCLUDED.raw_position AND projection_checkpoints.source_time<=EXCLUDED.source_time AND projection_checkpoints.source_position<=EXCLUDED.source_position`, infrastructureTenant, consumerName, m.Topic, m.Partition, m.Offset, cp.SourceTime, cp.SourcePosition, cp.RawPosition, cp.Partitions)
		if err != nil {
			return err
		}
		if s.Lease != nil {
			return saveVersionHeartbeatFrontier(ctx, tx, m)
		}
		return nil
	})
}

func saveVersionHeartbeatFrontier(ctx context.Context, tx pgx.Tx, m Message) error {
	_, err := tx.Exec(ctx, `INSERT INTO projection_checkpoints(tenant_id,consumer_name,topic,partition,committed_offset) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(tenant_id,consumer_name,topic,partition) DO UPDATE SET committed_offset=EXCLUDED.committed_offset,last_projected_at=clock_timestamp()
 WHERE projection_checkpoints.committed_offset<EXCLUDED.committed_offset`, infrastructureTenant, replayConsumer, m.Topic, m.Partition, m.Offset)
	return err
}
func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

// FeedAge requires every canonical inventory partition. Telemetry progress cannot
// prove inventory freshness. The extra five seconds conservatively bounds clock skew.
func (s *Store) FeedAge(ctx context.Context) (time.Duration, error) {
	var count int
	var oldest, newest *time.Time
	schema := s.Schema
	if schema == "" {
		schema = "public"
	}
	err := WithTenantSchema(ctx, s.DB, infrastructureTenant, schema, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*),min(source_time),max(source_time) FROM projection_checkpoints WHERE tenant_id=$1 AND consumer_name=$2 AND topic=$3 AND partition>=0 AND partition<6 AND partition_count=6`, infrastructureTenant, consumerName, topicInventory).Scan(&count, &oldest, &newest)
	})
	if err != nil {
		return 0, err
	}
	if count != 6 || oldest == nil || newest == nil || newest.After(time.Now().Add(5*time.Second)) {
		return 0, ErrCheckpoint
	}
	return max(0, time.Since(*oldest)+5*time.Second), nil
}

type ProjectionFreshness struct {
	ProjectedAt              time.Time `json:"lastProjectedAt"`
	MaxSeenStreamVersion     string    `json:"maxSeenStreamVersion"`
	ContiguousThroughVersion string    `json:"contiguousThroughVersion"`
	HasKnownGap              bool      `json:"hasKnownGap"`
	InventoryHasKnownGap     bool      `json:"inventoryHasKnownGap"`
	BindingFeedFresh         bool      `json:"bindingFeedFresh"`
}

func (s *Store) Freshness(ctx context.Context, tenant, device string) (ProjectionFreshness, error) {
	var f ProjectionFreshness
	schema := s.Schema
	if schema == "" {
		schema = "public"
	}
	err := WithTenantSchema(ctx, s.DB, tenant, schema, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT projected_at,max_seen_stream_version::text,contiguous_through_version::text,max_seen_stream_version>contiguous_through_version,EXISTS(SELECT 1 FROM stream_gaps WHERE tenant_id=$1 AND device_id=$2 AND stream='inventory' AND closed_at IS NULL) FROM device_latest WHERE tenant_id=$1 AND device_id=$2`, tenant, device).Scan(&f.ProjectedAt, &f.MaxSeenStreamVersion, &f.ContiguousThroughVersion, &f.HasKnownGap, &f.InventoryHasKnownGap)
	})
	if err != nil {
		return f, err
	}
	age, feedErr := s.FeedAge(ctx)
	f.BindingFeedFresh = feedErr == nil && age <= 5*time.Minute
	return f, nil
}
