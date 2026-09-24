package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"greenguard.local/projection-builder/history"
)

const streamInventory = "inventory"
const streamTelemetry = "telemetry"

type Store struct {
	DB                 TxStarter
	Schema             string // empty uses the live public schema
	HistoryWindow      time.Duration
	Lease              *writerLease
	HistoryOutOfWindow atomic.Uint64
}

func (s *Store) Apply(ctx context.Context, m Message, e map[string]any) error {
	tenant := e[fieldTenant].(string)
	skipped := false
	duplicate := false
	err := WithTenantSchema(ctx, s.DB, tenant, s.schemaName(), func(ctx context.Context, tx pgx.Tx) error {
		return s.applyInTx(ctx, tx, m, e, &skipped, &duplicate)
	})
	if err == nil && skipped {
		s.HistoryOutOfWindow.Add(1)
	}
	if err == nil && duplicate {
		return ErrDuplicate
	}
	return err
}

func (s *Store) schemaName() string {
	if s.Schema == "" {
		return "public"
	}
	return s.Schema
}

func (s *Store) historyWindow() time.Duration {
	if s.HistoryWindow == 0 {
		return history.DefaultWindow
	}
	return s.HistoryWindow
}

// applyInTx keeps the inbox, effect, notification and checkpoint in one transaction.
func (s *Store) applyInTx(ctx context.Context, tx pgx.Tx, m Message, e map[string]any, skipped, duplicate *bool) error {
	tenant := e[fieldTenant].(string)
	if err := s.Lease.check(ctx, tx); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '2s'"); err != nil {
		return err
	}
	if err := insertInbox(ctx, tx, m, e); err != nil {
		if errors.Is(err, ErrDuplicate) && s.Lease != nil {
			*duplicate = true
			return saveVersionFrontier(ctx, tx, m, tenant)
		}
		return err
	}
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared($1)", history.LockID); err != nil {
		return err
	}
	if err := applyEffect(ctx, tx, e, s.historyWindow(), skipped); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO projection_notifications(tenant_id,notification_id,resource_type,resource_id,event_id,purpose) VALUES($1,$2,'device',$3,$2,'projection_changed')`, tenant, e[fieldEvent], e[fieldAggregate]); err != nil {
		return err
	}
	if err := saveCheckpoint(ctx, tx, m, e); err != nil {
		return err
	}
	if s.Lease != nil {
		return saveVersionFrontier(ctx, tx, m, tenant)
	}
	return nil
}
func insertInbox(ctx context.Context, tx pgx.Tx, m Message, e map[string]any) error {
	tag, err := tx.Exec(ctx, `INSERT INTO consumer_inbox(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(consumer_name,tenant_id,event_id) DO NOTHING`, consumerName, e[fieldTenant], e[fieldEvent], m.Topic, m.Partition, m.Offset, string(m.Value))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	var equal bool
	err = tx.QueryRow(ctx, `SELECT event=$4::jsonb FROM consumer_inbox WHERE consumer_name=$1 AND tenant_id=$2 AND event_id=$3`, consumerName, e[fieldTenant], e[fieldEvent], string(m.Value)).Scan(&equal)
	if err != nil {
		return err
	}
	if equal {
		return ErrDuplicate
	}
	return ErrConflict
}
func applyEffect(ctx context.Context, tx pgx.Tx, e map[string]any, window time.Duration, skipped *bool) error {
	stream := streamInventory
	if e[fieldType] == typeTelemetry {
		stream = streamTelemetry
	}
	version, _ := strconv.ParseInt(e[fieldVersion].(string), 10, 64)
	maxSeen, contiguous, err := advanceStream(ctx, tx, e[fieldTenant], e[fieldAggregate], stream, version)
	if err != nil {
		return err
	}
	if stream == streamTelemetry {
		return applyReading(ctx, tx, e, maxSeen, contiguous, window, skipped)
	}
	return applyInventory(ctx, tx, e, contiguous)
}
func advanceStream(ctx context.Context, tx pgx.Tx, tenant, device any, stream string, v int64) (int64, int64, error) {
	// Inventory and telemetry share the inventory anchor so enrichment cannot
	// race a registration committing between the history insert and enrichment update.
	if stream == streamTelemetry {
		if _, err := lockStream(ctx, tx, tenant, device, streamInventory); err != nil {
			return 0, 0, err
		}
	}
	args := []any{tenant, device, stream}
	highest, err := lockStream(ctx, tx, tenant, device, stream)
	if err != nil {
		return 0, 0, err
	}
	if err = updateGaps(ctx, tx, args, highest, v); err != nil {
		return 0, 0, err
	}
	highest = max(highest, v)
	var contiguous int64
	err = tx.QueryRow(ctx, `SELECT COALESCE(min(from_version)-1,$4) FROM stream_gaps WHERE tenant_id=$1 AND device_id=$2 AND stream=$3 AND closed_at IS NULL`, append(args, highest)...).Scan(&contiguous)
	if err != nil {
		return 0, 0, err
	}
	_, err = tx.Exec(ctx, `UPDATE projection_streams SET max_seen_version=$4,contiguous_through_version=$5 WHERE tenant_id=$1 AND device_id=$2 AND stream=$3`, append(args, highest, contiguous)...)
	return highest, contiguous, err
}
func lockStream(ctx context.Context, tx pgx.Tx, tenant, device any, stream string) (int64, error) {
	args := []any{tenant, device, stream}
	if _, err := tx.Exec(ctx, `INSERT INTO projection_streams(tenant_id,device_id,stream) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, args...); err != nil {
		return 0, err
	}
	var highest int64
	err := tx.QueryRow(ctx, `SELECT max_seen_version FROM projection_streams WHERE tenant_id=$1 AND device_id=$2 AND stream=$3 FOR UPDATE`, args...).Scan(&highest)
	return highest, err
}
func updateGaps(ctx context.Context, tx pgx.Tx, args []any, highest, v int64) error {
	if v > highest && v-highest > 1 {
		return insertGap(ctx, tx, args, highest+1, v-1)
	}
	var from, to int64
	err := tx.QueryRow(ctx, `SELECT from_version,to_version FROM stream_gaps WHERE tenant_id=$1 AND device_id=$2 AND stream=$3 AND closed_at IS NULL AND from_version<=$4 AND to_version>=$4 FOR UPDATE`, append(args, v)...).Scan(&from, &to)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE stream_gaps SET closed_at=clock_timestamp() WHERE tenant_id=$1 AND device_id=$2 AND stream=$3 AND from_version=$4`, append(args, from)...)
	if err != nil {
		return err
	}
	if from < v {
		if err = insertGap(ctx, tx, args, from, v-1); err != nil {
			return err
		}
	}
	if v < to {
		return insertGap(ctx, tx, args, v+1, to)
	}
	return nil
}
func insertGap(ctx context.Context, tx pgx.Tx, args []any, from, to int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO stream_gaps(tenant_id,device_id,stream,from_version,to_version) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(tenant_id,device_id,stream,from_version) DO UPDATE SET to_version=EXCLUDED.to_version,closed_at=NULL`, append(args, from, to)...)
	return err
}
func applyInventory(ctx context.Context, tx pgx.Tx, e map[string]any, contiguous int64) error {
	rows, err := tx.Query(ctx, `SELECT event FROM consumer_inbox WHERE consumer_name=$1 AND tenant_id=$2
 AND event->>'aggregate_id'=$3 AND event->>'aggregate_type'='device'
 AND (event->>'aggregate_version')::bigint > COALESCE((SELECT inventory_version FROM device_views WHERE tenant_id=$2 AND device_id=$3::uuid),0)
 AND (event->>'aggregate_version')::bigint <= $4 ORDER BY (event->>'aggregate_version')::bigint`, consumerName, e[fieldTenant], e[fieldAggregate], contiguous)
	if err != nil {
		return err
	}
	// Materialize before writes: pgx cannot run another query with open rows.
	events, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (map[string]any, error) {
		var body []byte
		if err := r.Scan(&body); err != nil {
			return nil, err
		}
		v, err := decode(body)
		if err != nil {
			return nil, err
		}
		return v.(map[string]any), nil
	})
	if err != nil {
		return err
	}
	for _, event := range events {
		if err = foldInventory(ctx, tx, event); err != nil {
			return err
		}
	}
	return nil
}
func foldInventory(ctx context.Context, tx pgx.Tx, e map[string]any) error {
	payload := e[fieldPayload].(map[string]any)
	args := []any{e[fieldTenant], e[fieldAggregate], e[fieldVersion]}
	var err error
	switch e[fieldType] {
	case typeRegistered:
		_, err = tx.Exec(ctx, `INSERT INTO device_views(tenant_id,device_id,inventory_version,site_id,bin_id,serial_number,status) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(tenant_id,device_id) DO UPDATE SET inventory_version=EXCLUDED.inventory_version,site_id=EXCLUDED.site_id,bin_id=EXCLUDED.bin_id,serial_number=EXCLUDED.serial_number,status=EXCLUDED.status,updated_at=clock_timestamp() WHERE device_views.inventory_version<EXCLUDED.inventory_version`, append(args, payload["site_id"], payload["bin_id"], payload["serial_number"], payload["status"])...)
	case typeBinding:
		_, err = tx.Exec(ctx, `UPDATE device_views SET inventory_version=$3,site_id=$4,bin_id=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND device_id=$2 AND inventory_version<$3`, append(args, payload["site_id"], payload["bin_id"])...)
	case typeStatus:
		_, err = tx.Exec(ctx, `UPDATE device_views SET inventory_version=$3,status=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND device_id=$2 AND inventory_version<$3`, append(args, payload["status"])...)
	default:
		return fmt.Errorf("unhandled inventory event")
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE reading_history SET inventory_enrichment='applied' WHERE tenant_id=$1 AND device_id=$2 AND inventory_enrichment='pending'`, args[:2]...)
	return err
}
func applyReading(ctx context.Context, tx pgx.Tx, e map[string]any, highest, contiguous int64, window time.Duration, skipped *bool) error {
	p := e[fieldPayload].(map[string]any)
	measurements := p["measurements"].(map[string]any)
	tag, err := tx.Exec(ctx, `INSERT INTO reading_history(tenant_id,reading_id,device_id,event_id,stream_version,source_message_id,site_id,bin_id,observed_at,received_at,temperature_c,relative_humidity_percent,inventory_enrichment)
 SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN EXISTS(SELECT 1 FROM device_views WHERE tenant_id=$1 AND device_id=$3) THEN 'applied' ELSE 'pending' END WHERE projection_history_accepts($9::timestamptz,$13)`, e[fieldTenant], p["reading_id"], e[fieldAggregate], e[fieldEvent], e[fieldVersion], p["source_message_id"], p["site_id"], p["bin_id"], p["observed_at"], p["received_at"], number(measurements["temperature_c"]), number(measurements["relative_humidity_percent"]), window.Seconds())
	if err != nil {
		return err
	}
	*skipped = tag.RowsAffected() == 0
	args := []any{e[fieldTenant], e[fieldAggregate], p["reading_id"], e[fieldEvent], p["observed_at"], e[fieldVersion], highest, contiguous}
	_, err = tx.Exec(ctx, `INSERT INTO device_latest(tenant_id,device_id,reading_id,event_id,selected_observed_at,selected_stream_version,max_seen_stream_version,contiguous_through_version)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, args...)
	if err != nil {
		return err
	}
	var id string
	if err = tx.QueryRow(ctx, `SELECT reading_id FROM device_latest WHERE tenant_id=$1 AND device_id=$2 FOR UPDATE`, args[:2]...).Scan(&id); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE device_latest SET reading_id=$3,event_id=$4,selected_observed_at=$5,selected_stream_version=$6
 WHERE tenant_id=$1 AND device_id=$2 AND (selected_observed_at,selected_stream_version)<($5::timestamptz,$6::bigint)`, args[:6]...)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE device_latest SET max_seen_stream_version=$3,contiguous_through_version=$4,projected_at=clock_timestamp() WHERE tenant_id=$1 AND device_id=$2`, e[fieldTenant], e[fieldAggregate], highest, contiguous)
	return err
}
func number(v any) any {
	if n, ok := v.(json.Number); ok {
		f, _ := n.Float64()
		return f
	}
	return v
}
func saveCheckpoint(ctx context.Context, tx pgx.Tx, m Message, e map[string]any) error {
	_, err := tx.Exec(ctx, `INSERT INTO projection_checkpoints(tenant_id,consumer_name,topic,partition,committed_offset,last_event_occurred_at)
 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,consumer_name,topic,partition) DO UPDATE SET committed_offset=EXCLUDED.committed_offset,last_event_occurred_at=EXCLUDED.last_event_occurred_at,last_projected_at=clock_timestamp()
 WHERE projection_checkpoints.committed_offset<EXCLUDED.committed_offset`, e[fieldTenant], consumerName, m.Topic, m.Partition, m.Offset, e[fieldOccurred])
	return err
}

// The continuous writer advances the same global frontier used by replay. This
// is in the effect transaction so promotion cannot observe a checkpoint ahead
// of the data. The tenant setting is restored before commit.
func saveVersionFrontier(ctx context.Context, tx pgx.Tx, m Message, eventTenant string) error {
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id',$1,true)", infrastructureTenant); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO projection_replay_tenants(tenant_id,event_tenant) VALUES($1,$2) ON CONFLICT DO NOTHING`, infrastructureTenant, eventTenant); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO projection_checkpoints(tenant_id,consumer_name,topic,partition,committed_offset) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(tenant_id,consumer_name,topic,partition) DO UPDATE SET committed_offset=EXCLUDED.committed_offset,last_projected_at=clock_timestamp()
 WHERE projection_checkpoints.committed_offset<EXCLUDED.committed_offset`, infrastructureTenant, replayConsumer, m.Topic, m.Partition, m.Offset); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id',$1,true)", eventTenant)
	return err
}
