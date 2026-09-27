package migrations

import (
	"os"
	"testing"
)

func TestLiveMigrationIsRepeatable(t *testing.T) {
	url := os.Getenv("HARDWARE_MIGRATION_URL")
	if url == "" {
		t.Skip("HARDWARE_MIGRATION_URL required")
	}
	if err := Up(url); err != nil {
		t.Fatal(err)
	}
}
