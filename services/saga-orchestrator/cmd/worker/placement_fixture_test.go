package main

import (
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"greenguard.local/saga-orchestrator/internal/testfixtures"
)

func configureFixturePlacement(t *testing.T, cfg *pgxpool.Config) {
	t.Helper()
	testfixtures.ConfigurePlacement(t, cfg)
}
