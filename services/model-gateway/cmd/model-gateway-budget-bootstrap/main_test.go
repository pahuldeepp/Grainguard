package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProtectedFileRequiresAbsolute0600OwnedRegularFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "caps.json")
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := protectedFile(path, "caps", 1024); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := protectedFile(path, "caps", 1024); err == nil {
		t.Fatal("expected group-readable file rejection")
	}
	link := filepath.Join(dir, "caps-link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := protectedFile(link, "caps", 1024); err == nil {
		t.Fatal("expected symlink rejection")
	}
	if _, err := protectedFile("relative", "caps", 1024); err == nil {
		t.Fatal("expected relative path rejection")
	}
}
