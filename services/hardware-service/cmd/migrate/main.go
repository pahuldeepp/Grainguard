package main

import (
	shared "greenguard.local/go-migrations"
	"greenguard.local/hardware-service/migrations"
	"log"
	"os"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	return shared.Run("HARDWARE_MIGRATION_URL", os.Getenv, migrations.Up)
}
