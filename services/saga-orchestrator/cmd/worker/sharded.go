package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
	common "greenguard.local/go-common"
	transport "greenguard.local/kafka-transport"
	"greenguard.local/saga-orchestrator/saga"
	"log/slog"
	"time"
)

func runSharded(ctx context.Context, getenv func(string) string, cfg config) error {
	db, err := common.ShardedDBFromEnvironment(getenv, "saga-orchestrator", "greenguard_sagas", "saga_app")
	if err != nil {
		return err
	}
	defer db.Close()
	leases := saga.PlacementLeases{}
	if err := db.ForEachPrimary(ctx, func(shard string, _ *pgxpool.Pool) error {
		if err := db.WithInfrastructure(ctx, shard, "", func(context.Context, pgx.Tx) error { return nil }); err != nil {
			return err
		}
		leases[shard] = &saga.Leases{DB: db.InfrastructureDB(shard), Holder: cfg.holder + "/" + shard, TTL: cfg.ttl, MaxShards: cfg.maxShards}
		return nil
	}); err != nil {
		return err
	}
	defer func() {
		release, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		for shard, l := range leases {
			if err := l.Release(release); err != nil {
				slog.Warn("saga lease release failed", "physical_shard", shard, "error", err)
			}
		}
	}()
	security, err := transport.SecurityOptions(getenv)
	if err != nil {
		return err
	}
	producer, err := kgo.NewClient(append([]kgo.Opt{kgo.SeedBrokers(cfg.brokers...), kgo.RequiredAcks(kgo.AllISRAcks()), kgo.RecordDeliveryTimeout(15 * time.Second), kgo.ProducerLinger(0)}, security...)...)
	if err != nil {
		return err
	}
	defer producer.Close()
	if err := producer.Ping(ctx); err != nil {
		return fmt.Errorf("saga producer broker ping: %w", err)
	}
	health := newWorkerHealth(4, 90*time.Second)
	consumerExtra := append([]kgo.Opt{kgo.FetchIsolationLevel(kgo.ReadCommitted())}, health.consumerGroupOptions()...)
	consumer, err := kgo.NewClient(append(transport.Options(cfg.brokers, cfg.group, []string{saga.ResultTopic}, consumerExtra...), security...)...)
	if err != nil {
		return err
	}
	defer consumer.CloseAllowingRebalance()
	work, cancel := context.WithCancel(ctx)
	defer cancel()
	metrics := &saga.Metrics{}
	results := make(chan error, 6)
	if cfg.health != "" {
		stopHealth := serveWorkerHealth(work, cfg.health, health, results)
		defer stopHealth()
	}
	consumerDone := make(chan struct{})
	go func() {
		defer close(consumerDone)
		results <- resultConsumer{store: saga.Store{DB: db}, client: consumer, producer: producer, metrics: metrics, health: health}.run(work)
	}()
	if cfg.metrics != "" {
		stop := serveMetrics(work, cfg.metrics, saga.ShardedHandler(metrics, db), results)
		defer stop()
	}
	workersDone := make(chan struct{}, 4)
	for _, shard := range []string{"s1", "s2", "s3", "s4"} {
		w := worker{db: db.InfrastructureDB(shard), store: saga.Store{DB: db, Fence: leases}, leases: leases[shard], metrics: metrics, cursors: map[int]string{}, health: health, healthID: shard, publish: func(ctx context.Context, key, value []byte) error {
			return transport.Publish(ctx, producer, saga.CommandTopic, key, value, commandHeaders(value))
		}}
		go func() {
			defer func() { workersDone <- struct{}{} }()
			err := w.loop(work, cfg.ttl, nil)
			if err == nil && work.Err() == nil {
				err = errors.New("saga shard worker exited")
			}
			results <- err
		}()
	}
	select {
	case <-ctx.Done():
		err = nil
	case err = <-results:
	}
	cancel()
	for range 4 {
		<-workersDone
	}
	<-consumerDone
	return fmtErrorShard(err)
}
func fmtErrorShard(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("sharded saga runtime: %w", err)
}
