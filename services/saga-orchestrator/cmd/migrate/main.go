// Command migrate applies the saga authority schema.
package main

import (
	"os"

	shared "greenguard.local/go-migrations"
	"greenguard.local/saga-orchestrator/migrations"
)

func main() { shared.Main("SAGA_MIGRATION_URL", migrations.Up, os.Exit) }
