// Command maintain performs one bounded history partition maintenance pass.
package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"greenguard.local/projection-builder/history"
)

var exit = os.Exit
var maintain = history.Maintain

func run(ctx context.Context, getenv func(string) string) error {
	window, err := history.Window(getenv)
	if err != nil {
		return err
	}
	ahead, err := history.Ahead(getenv)
	if err != nil {
		return err
	}
	url := getenv("PROJECTION_MIGRATION_URL")
	if url == "" {
		return errors.New("PROJECTION_MIGRATION_URL is required")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return errors.New("invalid maintenance database configuration")
	}
	defer pool.Close()
	schema := getenv("PROJECTION_HISTORY_SCHEMA")
	if schema == "" {
		schema = "public"
	}
	return maintain(ctx, pool, window, ahead, schema)
}
func main() {
	if err := run(context.Background(), os.Getenv); err != nil {
		slog.Error("history maintenance failed", "error", err)
		exit(1)
	}
}
