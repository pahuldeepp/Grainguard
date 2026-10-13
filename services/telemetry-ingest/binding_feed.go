package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
)

const (
	bindingHeartbeat    = "binding.feed_checkpoint"
	bindingHeartbeatKey = "binding-feed-checkpoint"
	bindingFeedStale    = "binding_feed_stale"
	bindingClockSkew    = 5 * time.Second
)

// FeedCheckpoint is a source-originated barrier, emitted to every canonical
// partition only after the transformer has acknowledged preceding inventory rows.
// RawPosition identifies the covered offset in the single raw inventory partition.
type FeedCheckpoint struct {
	EventType      string    `json:"event_type"`
	SchemaVersion  int       `json:"schema_version"`
	SourceTime     time.Time `json:"source_time"`
	SourcePosition string    `json:"source_position"`
	RawPosition    int64     `json:"raw_position"`
	Partitions     int       `json:"partitions"`
}

type BindingFeed struct {
	DB             TxStarter
	TransportTopic string
	MaxStale       time.Duration
	Partitions     int
	Now            func() time.Time
	Stale          atomic.Uint64
	ClockSkew      atomic.Uint64
}

func parseCheckpoint(m BindingMessage, partitions int) (FeedCheckpoint, error) {
	var cp FeedCheckpoint
	decoder := json.NewDecoder(bytes.NewReader(m.Value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cp); err != nil {
		return cp, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return cp, ErrInvalidEvent
	}
	if m.Topic != bindingTopic || string(m.Key) != bindingHeartbeatKey || cp.EventType != bindingHeartbeat || cp.SchemaVersion != 1 {
		return cp, ErrInvalidEvent
	}
	if cp.SourceTime.IsZero() || cp.RawPosition < 0 || cp.SourcePosition == "" || len(cp.SourcePosition) > 128 {
		return cp, ErrInvalidEvent
	}
	if position, err := strconv.ParseUint(cp.SourcePosition, 10, 64); err != nil || position == 0 {
		return cp, ErrInvalidEvent
	}
	if cp.Partitions != partitions || m.Partition < 0 || int(m.Partition) >= partitions || m.Offset < 0 {
		return cp, ErrInvalidEvent
	}
	return cp, nil
}

func (f *BindingFeed) Heartbeat(ctx context.Context, m BindingMessage) error {
	now := f.Now()
	cp, err := parseCheckpoint(m, f.Partitions)
	if err != nil {
		return fmt.Errorf("%w: invalid feed checkpoint", ErrInvalidEvent)
	}
	if cp.SourceTime.After(now) {
		f.ClockSkew.Add(1)
		cp.SourceTime = now
	}
	if shards, ok := f.DB.(*common.ShardedDB); ok {
		return shards.ForEachPrimary(ctx, func(shard string, _ *pgxpool.Pool) error {
			local := BindingFeed{DB: shards.InfrastructureDB(shard)}
			return local.saveHeartbeat(ctx, m, cp)
		})
	}
	return f.saveHeartbeat(ctx, m, cp)
}
func (f *BindingFeed) saveHeartbeat(ctx context.Context, m BindingMessage, cp FeedCheckpoint) error {
	tx, err := f.DB.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer rollback(tx)
	// Infrastructure state is global to this telemetry database, not tenant data.
	// Offset and source-position comparisons fence replay; old barriers cannot refresh age.
	_, err = tx.Exec(ctx, `INSERT INTO binding_feed_checkpoints
  (partition_id, source_time, source_position, raw_position, consumed_offset, partition_count, transport_topic)
  VALUES ($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT (transport_topic, partition_id) DO UPDATE SET source_time=EXCLUDED.source_time,
   source_position=EXCLUDED.source_position, raw_position=EXCLUDED.raw_position,
   consumed_offset=EXCLUDED.consumed_offset, consumed_at=clock_timestamp(), partition_count=EXCLUDED.partition_count
  WHERE binding_feed_checkpoints.consumed_offset < EXCLUDED.consumed_offset
   AND binding_feed_checkpoints.raw_position < EXCLUDED.raw_position
   AND binding_feed_checkpoints.source_time <= EXCLUDED.source_time
 AND binding_feed_checkpoints.source_position::numeric <= EXCLUDED.source_position::numeric`,
		m.Partition, cp.SourceTime, cp.SourcePosition, cp.RawPosition, m.Offset, cp.Partitions, f.streamTopic(m))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

const bindingFeedQuery = `SELECT count(*), min(source_time), max(source_time)
 FROM binding_feed_checkpoints WHERE partition_id >= 0 AND partition_id < $1 AND partition_count = $1 AND transport_topic = $2`

func (f *BindingFeed) streamTopic(m BindingMessage) string {
	if m.TransportTopic != "" {
		return m.TransportTopic
	}
	if f.TransportTopic != "" {
		return f.TransportTopic
	}
	return bindingTopic
}

func (f *BindingFeed) age(ctx context.Context, tx pgx.Tx) (time.Duration, error) {
	var count int
	var oldest, newest *time.Time
	if err := tx.QueryRow(ctx, bindingFeedQuery, f.Partitions, f.streamTopic(BindingMessage{})).Scan(&count, &oldest, &newest); err != nil {
		return 0, err
	}
	if count != f.Partitions || oldest == nil || newest == nil {
		return 0, pgx.ErrNoRows
	}
	now := f.Now()
	if newest.After(now.Add(bindingClockSkew)) {
		return 0, ErrInvalidEvent
	}
	// Conservatively allow for source clock being ahead by the admitted skew.
	return max(0, now.Sub(*oldest)+bindingClockSkew), nil
}

func (f *BindingFeed) Check(ctx context.Context, tx pgx.Tx) error {
	if f.MaxStale == 0 {
		return nil
	}
	age, err := f.age(ctx, tx)
	if err != nil || age > f.MaxStale {
		f.Stale.Add(1)
		return newRejection(bindingFeedStale, 503, "The inventory binding feed is stale; retry later.")
	}
	return nil
}

// Ready reports whether the binding feed freshness gate would admit a reading.
// In sharded mode every primary must have a fresh checkpoint: a tenant cannot
// safely ingest while any shard's device-binding projection may be stale.
func (f *BindingFeed) Ready(ctx context.Context) bool {
	if f == nil || f.MaxStale == 0 {
		return true
	}
	if f.DB == nil {
		return false
	}
	fresh := func(db TxStarter) bool {
		tx, err := db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
		if err != nil {
			return false
		}
		defer rollback(tx)
		age, err := f.age(ctx, tx)
		return err == nil && age <= f.MaxStale
	}
	if shards, ok := f.DB.(*common.ShardedDB); ok {
		allFresh := true
		if err := shards.ForEachPrimary(ctx, func(shard string, _ *pgxpool.Pool) error {
			if !fresh(shards.InfrastructureDB(shard)) {
				allFresh = false
			}
			return nil
		}); err != nil {
			return false
		}
		return allFresh
	}
	return fresh(f.DB)
}

func (f *BindingFeed) metrics(ctx context.Context) string {
	age := math.Inf(1)
	if shards, ok := f.DB.(*common.ShardedDB); ok {
		age = 0
		err := shards.ForEachPrimary(ctx, func(shard string, _ *pgxpool.Pool) error {
			tx, err := shards.InfrastructureDB(shard).BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
			if err != nil {
				return err
			}
			defer rollback(tx)
			value, err := f.age(ctx, tx)
			if err == nil {
				age = max(age, value.Seconds())
			}
			return err
		})
		if err != nil {
			age = math.Inf(1)
		}
		return fmt.Sprintf("# TYPE binding_feed_age_seconds gauge\nbinding_feed_age_seconds %g\n# TYPE binding_feed_stale_total counter\nbinding_feed_stale_total %d\n", age, f.Stale.Load()) + fmt.Sprintf("# TYPE binding_feed_clock_skew_total counter\nbinding_feed_clock_skew_total %d\n", f.ClockSkew.Load())
	}
	tx, err := f.DB.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err == nil {
		defer rollback(tx)
		if value, err := f.age(ctx, tx); err == nil {
			age = value.Seconds()
		}
	}
	return fmt.Sprintf("# TYPE binding_feed_age_seconds gauge\nbinding_feed_age_seconds %g\n# TYPE binding_feed_stale_total counter\nbinding_feed_stale_total %d\n", age, f.Stale.Load()) + fmt.Sprintf("# TYPE binding_feed_clock_skew_total counter\nbinding_feed_clock_skew_total %d\n", f.ClockSkew.Load())
}
