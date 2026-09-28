package main

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// ProjectionWatermark identifies committed visibility in one projection schema.
// Decimal text preserves all bigint precision at notification/read boundaries.
type ProjectionWatermark struct {
	ShardIncarnation string
	PlacementEpoch   string
	Sequence         string
}

func admitProjectionTenant(ctx context.Context, tx pgx.Tx, tenant string) error {
	_, err := tx.Exec(ctx, `SELECT greenguard_internal.use_projection_tenant_placement($1::uuid)`, tenant)
	return err
}

// INSERT ... ON CONFLICT UPDATE locks this tenant/identity row until commit.
// Taking this lock before stream locks serializes all of a tenant's projection
// transactions, including independent aggregates and source partitions.
func advanceProjectionWatermark(ctx context.Context, tx pgx.Tx, tenant string) (ProjectionWatermark, error) {
	var w ProjectionWatermark
	err := tx.QueryRow(ctx, `INSERT INTO projection_watermarks(tenant_id,shard_incarnation,placement_epoch,sequence)
 VALUES($1,current_setting('app.shard_incarnation')::uuid,current_setting('app.placement_epoch')::bigint,1)
 ON CONFLICT(tenant_id,shard_incarnation,placement_epoch) DO UPDATE
 SET sequence=projection_watermarks.sequence+1,updated_at=clock_timestamp()
 RETURNING shard_incarnation::text,placement_epoch::text,sequence::text`, tenant).Scan(&w.ShardIncarnation, &w.PlacementEpoch, &w.Sequence)
	return w, err
}

func saveProjectionCompletions(ctx context.Context, tx pgx.Tx, e map[string]any, w ProjectionWatermark) error {
	// Inventory deltas can wait in the inbox for missing predecessors. Only the
	// fold's materialized inventory_version certifies their completion. A gap
	// fill therefore completes each exact inbox identity applied by that fold.
	inventory := e[fieldType] == typeRegistered || e[fieldType] == typeBinding || e[fieldType] == typeStatus
	_, err := tx.Exec(ctx, `INSERT INTO projection_event_completions
 (tenant_id,consumer_name,event_id,aggregate_type,aggregate_id,source_version,source_event_type,shard_incarnation,placement_epoch,projection_sequence)
 SELECT tenant_id,consumer_name,event_id,event->>'aggregate_type',(event->>'aggregate_id')::uuid,
 (event->>'aggregate_version')::bigint,event->>'event_type',$4::uuid,$5::bigint,$6::bigint
 FROM consumer_inbox i WHERE i.tenant_id=$1 AND i.consumer_name=$2
 AND (($7::boolean AND i.event->>'aggregate_type'='device' AND i.event->>'aggregate_id'=$8 AND i.event->>'event_type'=ANY($9::text[])
   AND (i.event->>'aggregate_version')::bigint <= COALESCE(
     (SELECT inventory_version FROM device_views WHERE tenant_id=$1 AND device_id=$8::uuid),0))
   OR (NOT $7::boolean AND i.event_id=$3::uuid))
 ON CONFLICT(tenant_id,consumer_name,event_id) DO NOTHING`, e[fieldTenant], consumerName, e[fieldEvent], w.ShardIncarnation, w.PlacementEpoch, w.Sequence, inventory, e[fieldAggregate], []string{typeRegistered, typeBinding, typeStatus})
	return err
}
