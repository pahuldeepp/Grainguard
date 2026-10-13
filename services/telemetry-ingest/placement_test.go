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
func TestIngestPlacementPauseDoesNotStartSQL(t *testing.T) {
	tenant, device := randomUUID(), randomUUID()
	g := ingNewIngestor(pausedPlacementDB{})
	_, err := g.Ingest(context.Background(), Principal{TenantID: tenant, Subject: device, Roles: []string{RoleDevice}}, device, []byte(`{"source_message_id":"paused-msg","observed_at":"2026-09-21T14:59:59.5Z","temperature_c":21.5}`), ingMeta())
	if !errors.Is(err, common.ErrTenantQuiescing) {
		t.Fatal("placement pause converted into ingest effect or poison", err)
	}
}
func TestControlMeshDeclarationRequiredForMachineAuthentication(t *testing.T) {
	if _, err := NewAPIKeyVerifierWithMesh("http://control.internal", "test-token", false); err == nil {
		t.Fatal("undeclared mesh admitted")
	}
	if _, err := NewAPIKeyVerifierWithMesh("http://control.internal", "test-token", true); err != nil {
		t.Fatal(err)
	}
}
