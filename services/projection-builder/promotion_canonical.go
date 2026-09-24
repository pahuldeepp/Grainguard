package main

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/twmb/franz-go/pkg/kgo"
)

// CanonicalPromotionVerifier is meant for PromoteReadViews. It runs only after
// the promotion advisory lock is held and uses the caller's privileged DB tx.
// A role filtered by FORCE RLS cannot produce an all-tenant proof.
func CanonicalPromotionVerifier(client *kgo.Client, validator *Processor) PromotionVerifier {
	return func(ctx context.Context, tx pgx.Tx, target string) (PromotionProof, error) {
		var incomplete PromotionProof
		if client == nil || validator == nil {
			return incomplete, errors.New("canonical verifier dependencies unavailable")
		}
		active, err := activeReadSchema(ctx, tx)
		if err != nil {
			return incomplete, err
		}
		if active == target {
			return incomplete, errors.New("target is already active")
		}
		before, err := verifyCanonicalPromotionState(ctx, tx, client, validator, active, target)
		if err != nil {
			return incomplete, err
		}
		if err := fenceAndRecheckFrontier(ctx, tx, client, target, before); err != nil {
			return incomplete, err
		}
		return PromotionProof{AllTenantsReplayed: true, StableCommonFrontier: true, LiveShadowEqual: true, CanonicalReferenceEqual: true, ZeroLag: true, PostSwapConsumerReady: true}, nil
	}
}

// verifyCanonicalPromotionState folds the canonical source and compares it with
// both the active and target schemas. It returns the frontier it observed.
func verifyCanonicalPromotionState(ctx context.Context, tx pgx.Tx, client *kgo.Client, validator *Processor, active, target string) ([]replayPartition, error) {
	if _, err := tx.Exec(ctx, `SET LOCAL row_security = off`); err != nil {
		return nil, err
	}
	cutoff, err := comparisonCutoff(ctx, tx)
	if err != nil {
		return nil, err
	}
	before, err := replayBounds(ctx, client)
	if err != nil {
		return nil, err
	}
	for _, p := range before {
		if p.Start != 0 {
			return nil, fmt.Errorf("canonical prefix missing: %s/%d", p.Topic, p.Partition)
		}
	}
	if err := checkShadowFrontier(ctx, tx, target, before); err != nil {
		return nil, err
	}
	canonical, err := canonicalReference(ctx, client, before, validator, cutoff)
	if err != nil {
		return nil, err
	}
	if err := checkPromotionCensus(ctx, tx, canonical, active, target); err != nil {
		return nil, err
	}
	for tenant, want := range canonical {
		if err := compareTenantInTx(ctx, tx, tenant, want, cutoff, active, target); err != nil {
			return nil, err
		}
	}
	return before, nil
}

func checkPromotionCensus(ctx context.Context, tx pgx.Tx, canonical map[string]referenceState, active, target string) error {
	liveTenants, err := projectionTenants(ctx, tx, active)
	if err != nil {
		return fmt.Errorf("live census: %w", err)
	}
	shadowTenants, err := projectionTenants(ctx, tx, target)
	if err != nil {
		return fmt.Errorf("shadow census: %w", err)
	}
	return compareTenantCensus(canonical, liveTenants, shadowTenants)
}

func compareTenantInTx(ctx context.Context, tx pgx.Tx, tenant string, want referenceState, cutoff time.Time, schemas ...string) error {
	for _, schema := range schemas {
		if _, err := tx.Exec(ctx, `SELECT set_config('search_path',$1,true)`, schema+",pg_catalog"); err != nil {
			return err
		}
		got, err := readReferenceStateAt(ctx, tx, tenant, cutoff)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(want, got) {
			return fmt.Errorf("tenant %s differs from canonical source in %s", tenant, schema)
		}
	}
	return nil
}

// fenceAndRecheckFrontier keeps the writer running during the expensive Kafka
// scan and tenant comparison, then fences it only for the short final proof.
func fenceAndRecheckFrontier(ctx context.Context, tx pgx.Tx, client *kgo.Client, target string, before []replayPartition) error {
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '2s'"); err != nil {
		return err
	}
	var writerReady bool
	if err := tx.QueryRow(ctx, `SELECT expires_at>clock_timestamp()+interval '5 seconds' FROM public.projection_writer_leases WHERE tenant_id=$1 AND schema_name=$2 FOR UPDATE`, infrastructureTenant, target).Scan(&writerReady); err != nil || !writerReady {
		return ErrWriterLease
	}
	after, err := replayBounds(ctx, client)
	if err != nil {
		return err
	}
	if len(before) != len(after) {
		return errors.New("canonical partition set changed")
	}
	if _, changed := frontierMismatch(after, before); changed {
		return errors.New("canonical frontier changed during promotion verification")
	}
	return checkShadowFrontier(ctx, tx, target, after)
}

func checkShadowFrontier(ctx context.Context, tx pgx.Tx, target string, parts []replayPartition) error {
	for _, p := range parts {
		if p.End == 0 {
			continue
		}
		var committed int64
		err := tx.QueryRow(ctx, fmt.Sprintf(`SELECT committed_offset FROM %s.projection_checkpoints WHERE tenant_id=$1 AND consumer_name=$2 AND topic=$3 AND partition=$4`, target), infrastructureTenant, replayConsumer, p.Topic, p.Partition).Scan(&committed)
		if err != nil {
			return fmt.Errorf("shadow checkpoint %s/%d: %w", p.Topic, p.Partition, err)
		}
		if committed != p.End-1 {
			return fmt.Errorf("shadow lag %s/%d: %d != %d", p.Topic, p.Partition, committed+1, p.End)
		}
	}
	return nil
}
