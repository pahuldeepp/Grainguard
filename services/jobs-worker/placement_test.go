package main

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
	"testing"
)

type pausedPlacementDB struct{}

func (pausedPlacementDB) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) {
	panic("unscoped process pool used")
}
func (pausedPlacementDB) WithTenantSchema(context.Context, string, string, func(context.Context, pgx.Tx) error) error {
	return common.ErrTenantQuiescing
}
func TestJobsPlacementPauseDoesNotPublishOrQuarantineAcceptedWork(t *testing.T) {
	called := false
	err := WithTenant(context.Background(), pausedPlacementDB{}, "11111111-1111-4111-8111-111111111111", func(context.Context, pgx.Tx) error { called = true; return nil })
	if !errors.Is(err, common.ErrTenantQuiescing) || called {
		t.Fatal("placement pause admitted jobs transaction", err)
	}
	in := &Intake{DB: pausedPlacementDB{}, Metrics: &Metrics{}}
	if err := in.apply(context.Background(), Record{Topic: "test", Value: fixture(t)}); !errors.Is(err, common.ErrTenantQuiescing) || in.Metrics.EventsQuarantine.Load() != 0 {
		t.Fatal("accepted event became poison during pause", err)
	}
}
