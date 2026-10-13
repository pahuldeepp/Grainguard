package hardware

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
	transport "greenguard.local/kafka-transport"
	"testing"
)

type pausedPlacementDB struct{}

func (pausedPlacementDB) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) {
	panic("unscoped fixed pool used")
}
func (pausedPlacementDB) WithTenantSchema(context.Context, string, string, func(context.Context, pgx.Tx) error) error {
	return common.ErrTenantQuiescing
}
func TestHardwarePlacementPausePreservesCommandAndExternalEffects(t *testing.T) {
	store := Store{DB: pausedPlacementDB{}}
	effects := 0
	if err := store.WithExternalAdmission(context.Background(), uuid(t), func() error { effects++; return nil }); !errors.Is(err, common.ErrTenantQuiescing) || effects != 0 {
		t.Fatal("external effect admitted during pause", err)
	}
	c := newCommand(t, uuid(t), uuid(t), uuid(t), uuid(t), "asset.reserve")
	body, _ := json.Marshal(c)
	commits := 0
	broker := &fakeKafka{}
	err := (Worker{Store: store, Client: broker}).process(context.Background(), transport.Message{Key: []byte(c.TenantID + ":" + c.SagaID), Value: body, Commit: func(context.Context) error { commits++; return nil }})
	if !errors.Is(err, common.ErrTenantQuiescing) || commits != 0 || len(broker.published) != 0 {
		t.Fatal("paused command discarded or published", err, commits)
	}
}
