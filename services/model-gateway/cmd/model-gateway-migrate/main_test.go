package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrationDSNFileRequires0600RegularFileOwnedByProcess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dsn")
	if err := os.WriteFile(path, []byte("fixture-dsn\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := migrationDSNFile(path)
	if err != nil || got != "fixture-dsn" {
		t.Fatalf("migrationDSNFile() = %q, %v", got, err)
	}
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := migrationDSNFile(path); err == nil {
		t.Fatal("expected group-readable DSN file to be rejected")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "dsn-link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := migrationDSNFile(link); err == nil {
		t.Fatal("expected symlink DSN file to be rejected")
	}
}

func TestMigrationDSNFileRequiresAbsolutePath(t *testing.T) {
	if _, err := migrationDSNFile("dsn"); err == nil {
		t.Fatal("expected relative DSN path to be rejected")
	}
}
