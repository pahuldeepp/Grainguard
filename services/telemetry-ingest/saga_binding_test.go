package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestBindingAwaitCompletesOnlyAfterLocalBindingAndRetriesPublish(t *testing.T) {
	db := pooled(t, 4)
	ctx := context.Background()
	command := BindingAwaitCommand{TenantID: randomUUID(), SagaID: randomUUID(),
		CommandID: randomUUID(), DeviceID: randomUUID(), SagaVersion: 3, FencingToken: 2}
	if err := RegisterBindingAwait(ctx, db, command); err != nil {
		t.Fatal(err)
	}
	assertBindingCommandHidden(ctx, t, db, command.CommandID)
	if sent, err := PublishNextBindingResult(ctx, db, command.TenantID,
		func(context.Context, []byte, []byte) error { t.Fatal("result before binding"); return nil }); err != nil || sent {
		t.Fatalf("premature result: %v %v", sent, err)
	}
	if err := RegisterBindingAwait(ctx, db, command); err != nil {
		t.Fatalf("duplicate command: %v", err)
	}
	conflict := command
	conflict.DeviceID = randomUUID()
	if err := RegisterBindingAwait(ctx, db, conflict); !errors.Is(err, ErrSagaBindingCommandConflict) {
		t.Fatalf("reused command ID: %v", err)
	}
	mustApply(t, db, eventSpec{kind: "device.registered", tenant: command.TenantID,
		device: command.DeviceID, version: 1}, BindingApplied)
	failed := errors.New("broker unavailable")
	publish := failingResultPublisher(t, command, failed)
	if _, err := PublishNextBindingResult(ctx, db, command.TenantID, publish); !errors.Is(err, failed) {
		t.Fatalf("broker failure: %v", err)
	}
	if sent, err := PublishNextBindingResult(ctx, db, command.TenantID,
		func(ctx context.Context, key, value []byte) error { _ = publish(ctx, key, value); return nil }); err != nil || !sent {
		t.Fatalf("retry result: %v %v", sent, err)
	}
	if sent, err := PublishNextBindingResult(ctx, db, command.TenantID,
		func(context.Context, []byte, []byte) error { t.Fatal("duplicate publish"); return nil }); err != nil || sent {
		t.Fatalf("duplicate result: %v %v", sent, err)
	}
}

// assertBindingCommandHidden proves another tenant cannot see the command row.
func assertBindingCommandHidden(ctx context.Context, t *testing.T, db TxStarter, commandID string) {
	t.Helper()
	otherTenant := randomUUID()
	if err := WithTenant(ctx, db, otherTenant, func(ctx context.Context, tx pgx.Tx) error {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM saga_binding_requests
			WHERE command_id=$1`, commandID).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			t.Fatalf("cross-tenant binding command visible: %d", count)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// failingResultPublisher checks each result and its stable ID, then returns failed.
func failingResultPublisher(t *testing.T, command BindingAwaitCommand, failed error) func(context.Context, []byte, []byte) error {
	var resultID string
	return func(_ context.Context, key, value []byte) error {
		var result BindingResult
		if err := json.Unmarshal(value, &result); err != nil {
			t.Fatal(err)
		}
		if string(key) != command.TenantID+":"+command.SagaID || result.CommandID != command.CommandID ||
			result.Step != "binding.await" || result.Outcome != "succeeded" ||
			result.SagaVersion != 3 || result.FencingToken != 2 {
			t.Fatalf("wrong result: %+v", result)
		}
		if resultID != "" && resultID != result.ResultID {
			t.Fatal("result identity changed across retry")
		}
		resultID = result.ResultID
		return failed
	}
}

func TestBindingAwaitAndInventoryEventRaceCannotLoseWakeup(t *testing.T) {
	db := pooled(t, 4)
	command := BindingAwaitCommand{TenantID: randomUUID(), SagaID: randomUUID(),
		CommandID: randomUUID(), DeviceID: randomUUID(), SagaVersion: 4, FencingToken: 1}
	var wg sync.WaitGroup
	errorsByPath := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		errorsByPath <- RegisterBindingAwait(context.Background(), db, command)
	}()
	go func() {
		defer wg.Done()
		_, err := ApplyInventoryEvent(context.Background(), db,
			eventSpec{kind: "device.registered", tenant: command.TenantID,
				device: command.DeviceID, version: 1}.json())
		errorsByPath <- err
	}()
	wg.Wait()
	close(errorsByPath)
	for err := range errorsByPath {
		if err != nil {
			t.Fatal(err)
		}
	}
	sent, err := PublishNextBindingResult(context.Background(), db, command.TenantID,
		func(context.Context, []byte, []byte) error { return nil })
	if err != nil || !sent {
		t.Fatalf("lost binding readiness result: sent=%v err=%v", sent, err)
	}
}
