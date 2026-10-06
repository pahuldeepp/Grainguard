package main

import (
	"context"
	"errors"
	common "greenguard.local/go-common"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"greenguard.local/projection-builder/history"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

type app struct {
	lease              *writerLease
	dbPool             *pgxpool.Pool
	shards             *common.ShardedDB
	shardLeases        []*writerLease
	processor          *Processor
	ping               func(context.Context) error
	close              func()
	feedAge            func(context.Context) (time.Duration, error)
	historyOutOfWindow func() uint64
}

var newApp = buildApp
var exit = os.Exit
var runService = run
var listen = net.Listen

// A promoted writer resumes the same group used by global replay. The direct
// projection role must keep RLS enforced in the live read database.
func writerTarget(schema, database, role string) (string, string, error) {
	if schema == "" {
		return "public", consumerName, nil
	}
	if !promotionIdentifier.MatchString(schema) || database != "greenguard_read" || role != "projection_app" {
		return "", "", errors.New("versioned writer requires read_v<N>, greenguard_read, and projection_app")
	}
	return schema, "greenguard.projection-builder." + schema, nil
}

// Public writers may use a separate deployment group without changing the
// durable projection identity. Versioned writers retain their promotion group.
func configuredWriterTarget(getenv func(string) string, database, role string) (string, string, error) {
	schema, group, err := writerTarget(getenv("PROJECTION_WRITE_SCHEMA"), database, role)
	if err != nil {
		return "", "", err
	}
	override := getenv("KAFKA_GROUP_ID")
	if override == "" {
		return schema, group, nil
	}
	if schema != "public" || len(override) > 249 || strings.IndexFunc(override, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-')
	}) >= 0 {
		return "", "", errors.New("KAFKA_GROUP_ID requires a public writer and a valid Kafka group identifier")
	}
	return schema, override, nil
}

func buildApp(getenv func(string) string) (*app, error) {
	if err := common.RequireShardRegistry(getenv); err != nil {
		return nil, err
	}
	window, err := history.Window(getenv)
	if err != nil {
		return nil, err
	}
	brokers := getenv("KAFKA_BROKERS")
	url := getenv("PROJECTION_DATABASE_URL")
	if strings.TrimSpace(brokers) == "" || (url == "" && getenv("SHARD_REGISTRY_FILE") == "") {
		return nil, errors.New("KAFKA_BROKERS and PROJECTION_DATABASE_URL are required")
	}
	schemas, err := loadSchemas(eventSchemaDir(getenv))
	if err != nil {
		return nil, err
	}
	if getenv("SHARD_REGISTRY_FILE") != "" {
		return buildShardedApp(getenv, window, brokers, schemas)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, errors.New("invalid projection database configuration")
	}
	targetSchema, group, err := configuredWriterTarget(getenv, cfg.ConnConfig.Database, cfg.ConnConfig.User)
	if err != nil {
		return nil, err
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		return nil, errors.New("open projection database failed")
	}
	lease, err := prepareWriterSchema(pool, targetSchema)
	if err != nil {
		pool.Close()
		return nil, err
	}
	provider, err := initTracing(getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	if err != nil {
		pool.Close()
		return nil, err
	}
	kafka, err := newKafkaWithPrefix(strings.Split(brokers, ","), group, getenv("KAFKA_TOPIC_PREFIX"))
	if err != nil {
		pool.Close()
		shutdownTracing(provider)
		return nil, err
	}
	store := &Store{DB: pool, TopicPrefix: getenv("KAFKA_TOPIC_PREFIX"), Schema: targetSchema, HistoryWindow: window, Lease: lease}
	p := &Processor{Tracer: provider.Tracer(consumerName), Source: kafka, Sink: kafka, Schemas: schemas, Apply: store.Apply, Heartbeat: store.Heartbeat, Attempts: 5, RetryDelay: time.Second, ProcessTimeout: 20 * time.Second}
	return &app{lease: lease, dbPool: pool, historyOutOfWindow: store.HistoryOutOfWindow.Load, processor: p, ping: func(ctx context.Context) error {
		var leaseErr error
		if lease != nil {
			leaseErr = lease.current(ctx)
		}
		return errors.Join(pool.Ping(ctx), kafka.Ping(ctx), leaseErr)
	}, feedAge: store.FeedAge, close: func() { kafka.Close(); pool.Close(); shutdownTracing(provider) }}, nil
}

// prepareWriterSchema checks forced RLS on a versioned target and takes its
// writer lease. The live public schema needs neither. The caller closes pool on error.
func prepareWriterSchema(pool *pgxpool.Pool, targetSchema string) (*writerLease, error) {
	if targetSchema == "public" {
		return nil, nil
	}
	var total, forced int
	err := pool.QueryRow(context.Background(), `SELECT count(*),count(*) FILTER (WHERE relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE relnamespace=$1::regnamespace AND relkind IN ('r','p') AND NOT relispartition`, targetSchema).Scan(&total, &forced)
	if err != nil || total != 19 || forced != total {
		return nil, errors.New("versioned writer schema missing or RLS incomplete")
	}
	return acquireWriterLease(context.Background(), pool, targetSchema)
}

func newHandler(a *app) http.Handler {
	return common.HealthHandler(func() bool { return a.processor.Ready.Load() }, a.ping, a.metrics)
}
func run(ctx context.Context, getenv func(string) string) error {
	if getenv("PROJECTION_MODE") == "replay" {
		return replayMain(ctx, getenv)
	}
	a, err := newApp(getenv)
	if err != nil {
		return err
	}
	defer a.close()
	return common.RunHTTP(ctx, getenv, "127.0.0.1:8082", newHandler(a), listen,
		func(ctx context.Context, server *http.Server, listener net.Listener) error {
			return serve(ctx, a, server, listener)
		})
}
func serve(parent context.Context, a *app, server *http.Server, listener net.Listener) error {
	var leaseLoop func(context.Context) <-chan error
	leases := a.shardLeases
	if a.lease != nil {
		leases = append(leases, a.lease)
	}
	if len(leases) > 0 {
		leaseLoop = func(ctx context.Context) <-chan error {
			done := make(chan error, 1)
			go func() {
				ticker := time.NewTicker(writerLeaseTTL / 3)
				defer ticker.Stop()
				for {
					select {
					case <-ctx.Done():
						done <- nil
						return
					case <-ticker.C:
						bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
						var err error
						for _, lease := range leases {
							if err = lease.renew(bounded); err != nil {
								break
							}
						}
						cancel()
						if err != nil {
							done <- err
							return
						}
					}
				}
			}()
			return done
		}
	}
	return common.ServeWorker(parent, server, listener, a.processor.Run, func() { a.processor.Ready.Store(false) }, leaseLoop, 5*time.Second)
}
func main() { common.RunMain(runService, exit) }
