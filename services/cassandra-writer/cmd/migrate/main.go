// Command migrate creates the history keyspace and tables idempotently.
package main

import (
	"context"
	"log/slog"
	"os"
	"time"

	"greenguard.local/cassandra-writer/history"
)

var exit = os.Exit
var openSystem = func(c history.Config) (history.Session, func(), error) {
	s, err := history.OpenSystem(c)
	if err != nil {
		return nil, nil, err
	}
	return s, s.Close, nil
}

func run(ctx context.Context, getenv func(string) string) error {
	cfg, err := history.LoadConfig(getenv)
	if err != nil {
		return err
	}
	ttl, err := history.TTL(getenv)
	if err != nil {
		return err
	}
	session, closeSession, err := openSystem(cfg)
	if err != nil {
		return err
	}
	defer closeSession()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := history.Migrate(ctx, session, cfg, ttl); err != nil {
		return err
	}
	slog.Info("history schema applied", "keyspace", cfg.Keyspace, "replication_factor", cfg.ReplicationFactor)
	return nil
}

func main() {
	if err := run(context.Background(), os.Getenv); err != nil {
		slog.Error("history migration failed", "error", err)
		exit(1)
	}
}
