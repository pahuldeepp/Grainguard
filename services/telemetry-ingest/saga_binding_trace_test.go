package main

import (
	"context"
	"encoding/json"
	"testing"
)

func bindingCommandBody(t *testing.T, tenant, sagaID, trace string) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"tenant_id": tenant, "saga_id": sagaID, "command_id": randomUUID(),
		"step": "binding.await", "saga_version": 1, "fencing_token": 1,
		"payload": map[string]string{"device_id": randomUUID()}, "traceparent": trace,
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestBindingAwaitCommandKeepsOnlyAValidSagaTrace(t *testing.T) {
	tenant, sagaID := randomUUID(), randomUUID()
	cases := map[string]string{
		ingTraceparent: ingTraceparent,
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
		"00-00000000000000000000000000000000-00f067aa0ba902b7-01": "",
		"garbage": "",
		"":        "",
	}
	for in, want := range cases {
		command, err := decodeBindingAwaitCommand([]byte(tenant+":"+sagaID), bindingCommandBody(t, tenant, sagaID, in))
		if err != nil || command.Traceparent != want {
			t.Errorf("trace %q -> %q (%v), want %q", in, command.Traceparent, err, want)
		}
	}
}

func TestBindingResultEchoesTheCommandTrace(t *testing.T) {
	db := pooled(t, 4)
	ctx := context.Background()
	command := BindingAwaitCommand{TenantID: randomUUID(), SagaID: randomUUID(), CommandID: randomUUID(),
		DeviceID: randomUUID(), SagaVersion: 1, FencingToken: 1, Traceparent: ingTraceparent}
	if err := RegisterBindingAwait(ctx, db, command); err != nil {
		t.Fatal(err)
	}
	mustApply(t, db, eventSpec{kind: "device.registered", tenant: command.TenantID,
		device: command.DeviceID, version: 1}, BindingApplied)
	var result BindingResult
	sent, err := PublishNextBindingResult(ctx, db, command.TenantID, func(_ context.Context, _, value []byte) error {
		return json.Unmarshal(value, &result)
	})
	if err != nil || !sent || result.Traceparent != ingTraceparent {
		t.Fatalf("result %+v sent=%v err=%v", result, sent, err)
	}
	if h := bindingResultHeaders(mustJSON(t, result)); h["traceparent"] != ingTraceparent || h["correlation_id"] != command.SagaID {
		t.Fatalf("headers %v", h)
	}
	if h := bindingResultHeaders([]byte(`{"saga_id":"s"}`)); h != nil {
		t.Fatalf("untraced result invented headers %v", h)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
