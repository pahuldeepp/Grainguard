package main

import (
	"context"
	"testing"
)

func TestRunRequiresDatabaseAndBroker(t *testing.T) {
	t.Setenv("HARDWARE_DATABASE_URL", "")
	t.Setenv("KAFKA_BROKERS", "")
	if err := run(context.Background()); err == nil {
		t.Fatal("missing database accepted")
	}
	t.Setenv("HARDWARE_DATABASE_URL", "postgresql://localhost/test")
	if err := run(context.Background()); err == nil {
		t.Fatal("missing broker accepted")
	}
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("HARDWARE_DATABASE_URL", "not a postgres URL")
	if err := run(context.Background()); err == nil {
		t.Fatal("invalid database URL accepted")
	}
}

func TestRunStopsCleanlyOnShutdown(t *testing.T) {
	t.Setenv("HARDWARE_DATABASE_URL", "postgresql://localhost/test")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := run(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
}
