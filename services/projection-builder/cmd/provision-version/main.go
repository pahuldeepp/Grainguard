package main

import (
	"context"
	"log/slog"
	"os"
	"time"

	"greenguard.local/projection-builder/migrations"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if len(os.Args) != 2 {
		slog.Error("usage: provision-version read_v<N>")
		os.Exit(2)
	}
	if err := migrations.ProvisionVersion(ctx, os.Getenv("PROJECTION_MIGRATION_URL"), os.Args[1]); err != nil {
		slog.Error("version provisioning failed", "error", err)
		os.Exit(1)
	}
}
