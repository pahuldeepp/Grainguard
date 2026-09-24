package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

// Record is one consumed Kafka record.
type Record struct {
	Topic     string
	Partition int32
	Offset    int64
	Value     []byte
}

// Source abstracts the Kafka consumer (franz-go in production, a fake in tests).
type Source interface {
	Poll(ctx context.Context) ([]Record, error)
	Commit(ctx context.Context, records []Record) error
}

// Intake turns committed alert lifecycle events into intents. Offsets are committed only
// after every record in the batch has a durable effect or a confirmed quarantine.
type Intake struct {
	DB         TxStarter
	Source     Source
	Metrics    *Metrics
	RetryDelay time.Duration
}

// HandleRecord applies one record, retrying transient database errors until ctx ends.
func (in *Intake) HandleRecord(ctx context.Context, rec Record) error {
	for {
		err := in.apply(ctx, rec)
		if err == nil {
			return nil
		}
		slog.Warn("alert event not applied; retrying", "topic", rec.Topic, "partition", rec.Partition, "offset", rec.Offset, "error", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(in.RetryDelay):
		}
	}
}

func (in *Intake) apply(ctx context.Context, rec Record) error {
	ev, err := ParseAlertEvent(rec.Value)
	if err == nil {
		var out Recorded
		out, err = RecordEvent(ctx, in.DB, ev, SourceRef{Topic: rec.Topic, Partition: rec.Partition, Offset: rec.Offset})
		if err == nil {
			in.count(out)
			return nil
		}
	}
	if !errors.Is(err, ErrPoison) && !errors.Is(err, ErrInvalidTenant) {
		return err
	}
	if qerr := Quarantine(ctx, in.DB, rec, err.Error()); qerr != nil {
		return qerr
	}
	in.Metrics.EventsQuarantine.Add(1)
	return nil
}

func (in *Intake) count(out Recorded) {
	in.Metrics.EventsProcessed.Add(1)
	if out.Duplicate {
		in.Metrics.EventsDuplicate.Add(1)
	}
	in.Metrics.IntentsCreated.Add(int64(len(out.Intents)))
}

// PollOnce handles one batch and then commits its offsets.
func (in *Intake) PollOnce(ctx context.Context) error {
	records, err := in.Source.Poll(ctx)
	var pollErr error
	if err != nil {
		pollErr = fmt.Errorf("poll: %w", err)
	}
	for _, rec := range records {
		if handleErr := in.HandleRecord(ctx, rec); handleErr != nil {
			return errors.Join(pollErr, handleErr)
		}
	}
	if len(records) == 0 {
		return pollErr
	}
	return errors.Join(pollErr, in.Source.Commit(ctx, records))
}

// Run polls until ctx ends.
func (in *Intake) Run(ctx context.Context) error {
	for ctx.Err() == nil {
		if err := in.PollOnce(ctx); err != nil && ctx.Err() == nil {
			slog.Error("alert intake failed", "error", err)
			select {
			case <-ctx.Done():
			case <-time.After(in.RetryDelay):
			}
		}
	}
	return nil
}

// Quarantine records a poison record's coordinates, hash and reason (never its payload).
func Quarantine(ctx context.Context, db TxStarter, rec Record, reason string) error {
	sum := sha256.Sum256(rec.Value)
	return inTx(ctx, db, "app.scope", "quarantine", func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO quarantined_events (source_topic, source_partition, source_offset, payload_sha256, reason)
			VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, rec.Topic, rec.Partition, rec.Offset, hex.EncodeToString(sum[:]), truncate(reason, 500))
		return err
	})
}
