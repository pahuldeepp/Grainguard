package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
)

func buildShardedApp(getenv func(string) string, window time.Duration, brokers string, schemas schemas) (*app, error) {
	db, err := common.ShardedDBFromEnvironment(getenv, "projection-builder", "greenguard_read", "projection_app")
	if err != nil {
		return nil, err
	}
	schema, group, err := writerTarget(getenv("PROJECTION_WRITE_SCHEMA"), "greenguard_read", "projection_app")
	if err != nil {
		db.Close()
		return nil, err
	}
	leases := map[string]*writerLease{}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.ForEachPrimary(ctx, func(shard string, pool *pgxpool.Pool) error {
		if err := db.WithInfrastructure(ctx, shard, "public", func(context.Context, pgx.Tx) error { return nil }); err != nil {
			return err
		}
		if schema == "public" {
			return nil
		}
		var total, forced int
		if err := pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE relnamespace=$1::regnamespace AND relkind IN('r','p') AND NOT relispartition`, schema).Scan(&total, &forced); err != nil || total != 19 || forced != total {
			return errors.New("versioned shard schema missing or RLS incomplete")
		}
		lease, err := acquireWriterLease(ctx, db.InfrastructureDB(shard), schema)
		if err != nil {
			return err
		}
		leases[shard] = lease
		return nil
	}); err != nil {
		db.Close()
		return nil, err
	}
	provider, err := initTracing(getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	if err != nil {
		db.Close()
		return nil, err
	}
	kafka, err := newKafka(strings.Split(brokers, ","), group)
	if err != nil {
		db.Close()
		shutdownTracing(provider)
		return nil, err
	}
	store := &Store{DB: db, Schema: schema, HistoryWindow: window, ShardLeases: leases}
	p := &Processor{Tracer: provider.Tracer(consumerName), Source: kafka, Sink: kafka, Schemas: schemas, Apply: store.Apply, Heartbeat: store.Heartbeat, Attempts: 5, RetryDelay: time.Second, ProcessTimeout: 20 * time.Second}
	a := &app{shards: db, processor: p, historyOutOfWindow: store.HistoryOutOfWindow.Load, feedAge: store.FeedAge,
		ping: func(ctx context.Context) error {
			errs := []error{db.Ping(ctx), kafka.Ping(ctx)}
			for _, shard := range []string{"s1", "s2", "s3", "s4"} {
				if lease := leases[shard]; lease != nil {
					errs = append(errs, lease.current(ctx))
				}
			}
			return errors.Join(errs...)
		}, close: func() { kafka.Close(); db.Close(); shutdownTracing(provider) }}
	for _, shard := range []string{"s1", "s2", "s3", "s4"} {
		if lease := leases[shard]; lease != nil {
			a.shardLeases = append(a.shardLeases, lease)
		}
	}
	return a, nil
}

func (s *Store) checkLease(ctx context.Context, tx pgx.Tx) error {
	if s.Lease != nil {
		return s.Lease.check(ctx, tx)
	}
	if len(s.ShardLeases) == 0 {
		return nil
	}
	var shard string
	if err := tx.QueryRow(ctx, `SELECT current_setting('app.shard_id')`).Scan(&shard); err != nil {
		return err
	}
	lease := s.ShardLeases[shard]
	if lease == nil {
		return ErrWriterLease
	}
	return lease.check(ctx, tx)
}
func (s *Store) hasWriterLease() bool { return s.Lease != nil || len(s.ShardLeases) > 0 }

func (s *Store) forEachInfrastructure(ctx context.Context, fn func(*Store) error) error {
	db, ok := s.DB.(*common.ShardedDB)
	if !ok {
		return fn(s)
	}
	return db.ForEachPrimary(ctx, func(shard string, _ *pgxpool.Pool) error {
		local := &Store{DB: db.InfrastructureDB(shard), Schema: s.Schema, HistoryWindow: s.HistoryWindow, Lease: s.ShardLeases[shard]}
		return fn(local)
	})
}
