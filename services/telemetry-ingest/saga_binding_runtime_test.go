package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestSagaBindingWorkerRequiresBrokersAndRejectsRetiredTenantList(t *testing.T) {
	env := map[string]string{"SAGA_BINDING_ENABLED": "1"}
	getenv := func(key string) string { return env[key] }
	if _, err := startSagaBindingRuntime(context.Background(), nil, getenv); err == nil {
		t.Fatal("enabled worker started without Kafka brokers")
	}
	env["KAFKA_BROKERS"] = "127.0.0.1:59092"
	env["SAGA_BINDING_TENANT_IDS"] = randomUUID()
	if _, err := startSagaBindingRuntime(context.Background(), nil, getenv); err == nil || !strings.Contains(err.Error(), "retired") {
		t.Fatalf("retired tenant list accepted: %v", err)
	}
	env["SAGA_BINDING_ENABLED"] = "0"
	if worker, err := startSagaBindingRuntime(context.Background(), nil, getenv); err != nil || worker.stop != nil {
		t.Fatalf("disabled worker: %+v %v", worker, err)
	}
}

func TestBindingResultsPassReturnsCursorAndStopsOnError(t *testing.T) {
	ctx := context.Background()
	full := make([]string, maxBindingTenantsPerPass)
	for i := range full {
		full[i] = randomUUID()
	}
	discover := func(tenants []string, err error) bindingTenantDiscovery {
		return func(context.Context, TxStarter, string) ([]string, error) { return tenants, err }
	}
	failing := errors.New("selector down")
	if next, err := publishBindingResultsPass(ctx, nil, "c", discover(nil, failing), publishAll, nil); !errors.Is(err, failing) || next != "c" {
		t.Fatalf("selector error: %q %v", next, err)
	}
	if next, err := publishBindingResultsPass(ctx, nil, "c", discover(nil, nil), publishAll, nil); err != nil || next != "" {
		t.Fatalf("short pass must wrap: %q %v", next, err)
	}
	// A nil publisher is rejected per tenant, which stops the pass at that tenant.
	if next, err := publishBindingResultsPass(ctx, nil, "", discover(full, nil), publishAll, nil); err == nil || next != full[0] {
		t.Fatalf("publish error must stop at the tenant: %q %v", next, err)
	}
}

func TestDecodeBindingAwaitCommandRejectsSpoofedKeyAndBadDevice(t *testing.T) {
	tenant, sagaID, commandID, device := randomUUID(), randomUUID(), randomUUID(), randomUUID()
	body, err := json.Marshal(map[string]any{
		"tenant_id": tenant, "saga_id": sagaID, "command_id": commandID,
		"step": "binding.await", "saga_version": 4, "fencing_token": 2,
		"payload": map[string]string{"device_id": device},
	})
	if err != nil {
		t.Fatal(err)
	}
	command, err := decodeBindingAwaitCommand([]byte(tenant+":"+sagaID), body)
	if err != nil || command.DeviceID != device {
		t.Fatalf("valid command: %+v %v", command, err)
	}
	if _, err := decodeBindingAwaitCommand([]byte(randomUUID()+":"+sagaID), body); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("spoofed Kafka key: %v", err)
	}
	var changed map[string]any
	if err := json.Unmarshal(body, &changed); err != nil {
		t.Fatal(err)
	}
	changed["payload"] = map[string]string{"device_id": "not-a-device"}
	bad, _ := json.Marshal(changed)
	if _, err := decodeBindingAwaitCommand([]byte(tenant+":"+sagaID), bad); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("bad device accepted: %v", err)
	}
}
