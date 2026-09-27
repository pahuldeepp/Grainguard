package main

import (
	"errors"
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
	url := os.Getenv("HARDWARE_MIGRATION_URL")
	if url == "" {
		return errors.New("HARDWARE_MIGRATION_URL required")
	}
	return migrations.Up(url)
}
