package saga

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
func TestSagaPlacementPausePreservesExternalCommand(t *testing.T) {
	s := Store{DB: pausedPlacementDB{}}
	published := 0
	_, err := s.PublishNextCommand(context.Background(), "11111111-1111-4111-8111-111111111111", func(context.Context, []byte, []byte) error { published++; return nil })
	if !errors.Is(err, common.ErrTenantQuiescing) || published != 0 {
		t.Fatal("paused saga dispatched or marked command", err)
	}
}
