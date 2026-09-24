package main

import (
	"os"
	"testing"
)

func TestRunRequiresTheMigrationURL(t *testing.T) {
	if err := run(func(string) string { return "" }); err == nil || err.Error() != "TELEMETRY_MIGRATION_URL is required" {
		t.Fatalf("got %v", err)
	}
}

func TestRunAppliesMigrationsIdempotently(t *testing.T) {
	url := os.Getenv("TELEMETRY_MIGRATION_URL")
	if url == "" {
		t.Skip("TELEMETRY_MIGRATION_URL is not set; run through make")
	}
	for i := 0; i < 2; i++ {
		if err := run(func(string) string { return url }); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMainExitsNonZeroOnFailure(t *testing.T) {
	t.Setenv("TELEMETRY_MIGRATION_URL", "")
	code := -1
	exit = func(c int) { code = c }
	defer func() { exit = os.Exit }()
	main()
	if code != 1 {
		t.Fatalf("exit code %d", code)
	}
}

func TestMainSucceedsAgainstTheLocalDatabase(t *testing.T) {
	if os.Getenv("TELEMETRY_MIGRATION_URL") == "" {
		t.Skip("TELEMETRY_MIGRATION_URL is not set; run through make")
	}
	exit = func(c int) { t.Errorf("unexpected exit %d", c) }
	defer func() { exit = os.Exit }()
	main()
}
