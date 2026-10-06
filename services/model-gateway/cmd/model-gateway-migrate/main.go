package main

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"syscall"
	"time"

	modelgateway "greenguard.local/model-gateway"
)

func migrationDSNFile(path string) (string, error) {
	if path == "" || !filepath.IsAbs(path) {
		return "", errors.New("AI_MIGRATION_DATABASE_URL_FILE must be an absolute path")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() < 1 || info.Size() > 8192 {
		return "", errors.New("migration DSN must be a protected regular file")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Getuid() {
		return "", errors.New("migration DSN file owner does not match the process")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("cannot read migration DSN file")
	}
	return string(bytesTrimSpace(data)), nil
}

func bytesTrimSpace(value []byte) []byte {
	start, end := 0, len(value)
	for start < end && (value[start] == ' ' || value[start] == '\n' || value[start] == '\r' || value[start] == '\t') {
		start++
	}
	for end > start && (value[end-1] == ' ' || value[end-1] == '\n' || value[end-1] == '\r' || value[end-1] == '\t') {
		end--
	}
	return value[start:end]
}

func run() error {
	dsn, err := migrationDSNFile(os.Getenv("AI_MIGRATION_DATABASE_URL_FILE"))
	if err != nil {
		return err
	}
	if err := modelgateway.ValidateMigrationDSN(dsn, os.Getenv("AI_RDS_HOST")); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := modelgateway.ApplyEmbeddedMigrations(ctx, dsn); err != nil {
		return err
	}
	log.Print("Model Gateway database migrations applied")
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
