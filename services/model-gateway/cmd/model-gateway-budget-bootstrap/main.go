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

func protectedFile(path, name string, max int64) ([]byte, error) {
	if path == "" || !filepath.IsAbs(path) {
		return nil, errors.New(name + " must be an absolute path")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() < 1 || info.Size() > max {
		return nil, errors.New(name + " must be a bounded protected regular file")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Getuid() {
		return nil, errors.New(name + " owner does not match the process")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("cannot read " + name)
	}
	return data, nil
}

func run() error {
	dsnBytes, err := protectedFile(os.Getenv("MODEL_GATEWAY_BUDGET_DSN_FILE"), "budget DSN", 8192)
	if err != nil {
		return err
	}
	capsBytes, err := protectedFile(os.Getenv("MODEL_GATEWAY_BUDGET_CAPS_FILE"), "budget caps", 1<<20)
	if err != nil {
		return err
	}
	caps, err := modelgateway.ParseBudgetCaps(capsBytes)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := modelgateway.ApplyBudgetCaps(ctx, string(trimSpace(dsnBytes)), os.Getenv("AI_RDS_HOST"), caps); err != nil {
		return err
	}
	log.Print("Model Gateway monthly budget caps ensured; existing held and spent usage preserved")
	return nil
}

func trimSpace(data []byte) []byte {
	start, end := 0, len(data)
	for start < end && (data[start] == ' ' || data[start] == '\n' || data[start] == '\r' || data[start] == '\t') {
		start++
	}
	for end > start && (data[end-1] == ' ' || data[end-1] == '\n' || data[end-1] == '\r' || data[end-1] == '\t') {
		end--
	}
	return data[start:end]
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
