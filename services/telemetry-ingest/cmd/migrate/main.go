// Command migrate applies the telemetry-ingest database migrations.
package main

import (
	shared "greenguard.local/go-migrations"
	"greenguard.local/telemetry-ingest/migrations"
	"os"
)

var exit = os.Exit

const migrationURL = "TELEMETRY_MIGRATION_URL"

var errUsage = shared.UsageError(migrationURL + " is required")

func run(getenv func(string) string) error { return shared.Run(migrationURL, getenv, migrations.Up) }
func main()                                { shared.Main(migrationURL, migrations.Up, exit) }
