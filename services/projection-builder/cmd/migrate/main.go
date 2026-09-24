// Command migrate applies the projection-builder database migrations.
package main

import (
	shared "greenguard.local/go-migrations"
	"greenguard.local/projection-builder/migrations"
	"os"
)

var exit = os.Exit

const migrationURL = "PROJECTION_MIGRATION_URL"

var errUsage = shared.UsageError(migrationURL + " is required")

func run(getenv func(string) string) error { return shared.Run(migrationURL, getenv, migrations.Up) }
func main()                                { shared.Main(migrationURL, migrations.Up, exit) }
