// Command migrate applies the telemetry database migrations.
package main

import (
	"log/slog"
	"os"

	"greenguard.local/telemetry-ingest/migrations"
)

var exit = os.Exit

func run(getenv func(string) string) error {
	url := getenv("TELEMETRY_MIGRATION_URL")
	if url == "" {
		return errUsage
	}
	return migrations.Up(url)
}

func main() {
	if err := run(os.Getenv); err != nil {
		slog.Error("migration failed", "error", err)
		exit(1)
	}
}

type usageError string

func (e usageError) Error() string { return string(e) }

const errUsage = usageError("TELEMETRY_MIGRATION_URL is required")
