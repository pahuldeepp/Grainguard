package saga

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
)

func TestLiveCommandPublishRetriesAndStaysTenantScoped(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	store := Store{DB: pool}
	a, b := testUUID(t), testUUID(t)
	first, err := store.Start(ctx, StartRequest{TenantID: a, IdempotencyKey: testUUID(t), DeviceID: testUUID(t), AssetID: testUUID(t)})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Start(ctx, StartRequest{TenantID: b, IdempotencyKey: testUUID(t), DeviceID: testUUID(t), AssetID: testUUID(t)})
	if err != nil {
		t.Fatal(err)
	}
	var firstID string
	failed := errors.New("broker unavailable")
	_, err = store.PublishNextCommand(ctx, a, func(_ context.Context, key, value []byte) error {
		command := decodeTestCommand(t, a, first.SagaID, key, value)
		firstID = command.CommandID
		return failed
	})
	if !errors.Is(err, failed) {
		t.Fatalf("broker failure must roll back publish marker: %v", err)
	}
	assertPublishedCount(t, ctx, pool, a, first.SagaID, 0)
	var retriedID string
	sent, err := store.PublishNextCommand(ctx, a, func(_ context.Context, key, value []byte) error {
		retriedID = decodeTestCommand(t, a, first.SagaID, key, value).CommandID
		return nil
	})
	if err != nil || !sent || retriedID != firstID {
		t.Fatalf("retry must keep stable command ID: sent=%v first=%s retry=%s err=%v", sent, firstID, retriedID, err)
	}
	assertPublishedCount(t, ctx, pool, a, first.SagaID, 1)
	if sent, err = store.PublishNextCommand(ctx, a, func(context.Context, []byte, []byte) error {
		t.Fatal("published command dispatched twice")
		return nil
	}); err != nil || sent {
		t.Fatalf("no pending tenant A command: sent=%v err=%v", sent, err)
	}
	assertPublishedCount(t, ctx, pool, b, second.SagaID, 0)
	if sent, err = store.PublishNextCommand(ctx, b, func(_ context.Context, key, value []byte) error {
		decodeTestCommand(t, b, second.SagaID, key, value)
		return nil
	}); err != nil || !sent {
		t.Fatalf("tenant B should independently dispatch: sent=%v err=%v", sent, err)
	}
}

func decodeTestCommand(t *testing.T, tenant, sagaID string, key, value []byte) Command {
	t.Helper()
	var command Command
	if err := json.Unmarshal(value, &command); err != nil {
		t.Fatal(err)
	}
	if string(key) != tenant+":"+sagaID || command.TenantID != tenant || command.SagaID != sagaID ||
		command.CommandID == "" || command.Step != "asset.reserve" || command.SagaVersion != 1 || command.FencingToken != 1 {
		t.Fatalf("incorrect Kafka command: key=%s command=%+v", key, command)
	}
	return command
}

func assertPublishedCount(t *testing.T, ctx context.Context, pool common.TxStarter, tenant, sagaID string, want int) {
	t.Helper()
	var got int
	if err := common.WithTenantSchema(ctx, pool, tenant, "", func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM saga_command_outbox
			WHERE tenant_id=$1 AND saga_id=$2 AND published_at IS NOT NULL`, tenant, sagaID).Scan(&got)
	}); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("published command count = %d, want %d", got, want)
	}
}

func TestDecodeResultRequiresMatchingTenantKey(t *testing.T) {
	tenant, sagaID := testUUID(t), testUUID(t)
	result := Result{StepResult: StepResult{TenantID: tenant, SagaID: sagaID, CommandID: testUUID(t),
		ResultID: testUUID(t), SagaVersion: 1, FencingToken: 1, Outcome: "succeeded"}, Step: "asset.reserve"}
	value, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeResult(value, []byte(tenant+":"+sagaID)); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeResult(value, []byte(testUUID(t)+":"+sagaID)); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("wrong tenant key accepted: %v", err)
	}
	if _, err := DecodeResult([]byte(`{`), []byte(tenant+":"+sagaID)); err == nil {
		t.Fatal("malformed result accepted")
	}
}
