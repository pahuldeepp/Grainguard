package main

import (
	"os"
	"testing"
)

func TestRunRequiresURL(t *testing.T) {
	t.Setenv("HARDWARE_MIGRATION_URL", "")
	if err := run(); err == nil {
		t.Fatal("missing migration URL accepted")
	}
}

func TestRunLiveMigration(t *testing.T) {
	url := os.Getenv("HARDWARE_MIGRATION_URL")
	if url == "" {
		t.Skip("HARDWARE_MIGRATION_URL required")
	}
	if err := run(); err != nil {
		t.Fatal(err)
	}
}
