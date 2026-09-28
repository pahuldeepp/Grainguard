package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/twmb/franz-go/pkg/kgo"
	transport "greenguard.local/kafka-transport"
)

const sagaCommandTopic = "greenguard.saga.commands.v1"
const sagaResultTopic = "greenguard.saga.results.v1"
const sagaBindingAwaitStep = "binding.await"

type sagaBindingRuntime struct {
	done   chan error
	joined chan struct{}
	stop   context.CancelFunc
	client *kgo.Client
}

func (w *sagaBindingRuntime) close() {
	if w.stop != nil {
		w.stop()
		<-w.joined
		w.client.CloseAllowingRebalance()
	}
}

func startSagaBindingRuntime(parent context.Context, db TxStarter, getenv func(string) string) (*sagaBindingRuntime, error) {
	if getenv("SAGA_BINDING_ENABLED") != "1" {
		return &sagaBindingRuntime{}, nil
	}
	if getenv("SAGA_BINDING_TENANT_IDS") != "" {
		return nil, errors.New("SAGA_BINDING_TENANT_IDS is retired: the worker discovers tenants with pending results itself")
	}
	brokers := strings.FieldsFunc(getenv("KAFKA_BROKERS"), func(r rune) bool { return r == ',' || r == ' ' })
	if len(brokers) == 0 {
		return nil, errors.New("SAGA_BINDING_ENABLED requires KAFKA_BROKERS")
	}
	group := getenv("SAGA_BINDING_GROUP")
	if group == "" {
		group = "telemetry-saga-binding-v1"
	}
	options, err := transport.SecureOptions(brokers, group,
		[]string{sagaCommandTopic}, kgo.FetchIsolationLevel(kgo.ReadCommitted()))
	if err != nil {
		return nil, err
	}
	client, err := kgo.NewClient(options...)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	w := &sagaBindingRuntime{done: make(chan error, 1), joined: make(chan struct{}), stop: cancel, client: client}
	go func() { defer close(w.joined); w.done <- runSagaBinding(ctx, db, client) }()
	return w, nil
}

const (
	maxBindingTenantsPerPass   = 100
	maxBindingResultsPerTenant = 10
)

// bindingResultTenants asks the ID-only SECURITY DEFINER selector which tenants
// have unpublished results after the cursor. It never reads row data.
func bindingResultTenants(ctx context.Context, db TxStarter, after string) ([]string, error) {
	tx, err := db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var cursor any
	if after != "" {
		cursor = after
	}
	rows, err := tx.Query(ctx, `SELECT tenant_id::text FROM saga_binding_result_tenants($1::uuid,$2)`, cursor, maxBindingTenantsPerPass)
	if err != nil {
		return nil, err
	}
	tenants, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	return tenants, tx.Commit(ctx)
}

type bindingTenantDiscovery func(context.Context, TxStarter, string) ([]string, error)

// publishAll includes every discovered tenant; tests narrow it to their own.
func publishAll(string) bool { return true }

// publishBindingResultsPass is one bounded round-robin pass: at most 100 tenants
// after the cursor and 10 results each, each inside its tenant's RLS
// transaction. It returns the next cursor; "" wraps to the first tenant.
func publishBindingResultsPass(ctx context.Context, db TxStarter, cursor string, discover bindingTenantDiscovery,
	include func(string) bool, publish func(context.Context, []byte, []byte) error) (string, error) {
	tenants, err := discover(ctx, db, cursor)
	if err != nil {
		return cursor, err
	}
	for _, tenant := range tenants {
		if !include(tenant) {
			continue
		}
		for sent := 0; sent < maxBindingResultsPerTenant; sent++ {
			work, cancel := context.WithTimeout(ctx, 20*time.Second)
			ok, err := PublishNextBindingResult(work, db, tenant, publish)
			cancel()
			if err != nil {
				return tenant, fmt.Errorf("tenant %s: %w", tenant, err)
			}
			if !ok {
				break
			}
		}
	}
	if len(tenants) < maxBindingTenantsPerPass {
		return "", nil
	}
	return tenants[len(tenants)-1], nil
}

func runSagaBinding(ctx context.Context, db TxStarter, client transport.Client) error {
	results := make(chan error, 1)
	go func() { results <- consumeSagaBindingCommands(ctx, db, client) }()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	publish := func(ctx context.Context, key, value []byte) error {
		return transport.Publish(ctx, client, sagaResultTopic, key, value, bindingResultHeaders(value))
	}
	cursor := ""
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-results:
			return err
		case <-ticker.C:
			next, err := publishBindingResultsPass(ctx, db, cursor, bindingResultTenants, publishAll, publish)
			if err != nil && ctx.Err() == nil {
				// Retry from the failing tenant on the next tick.
				slog.Error("saga binding result publish failed; will retry", "error", err)
			}
			cursor = next
		}
	}
}

func consumeSagaBindingCommands(ctx context.Context, db TxStarter, client transport.Client) error {
	for ctx.Err() == nil {
		message, err := transport.NextMessage(ctx, client, errors.New("saga binding command offset lost"))
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if err := handleSagaBindingCommand(ctx, db, client, message); err != nil {
			return err
		}
		if err := message.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

// handleSagaBindingCommand applies or quarantines one command; the caller commits
// the offset only after this returns nil.
func handleSagaBindingCommand(ctx context.Context, db TxStarter, client transport.Client, message transport.Message) error {
	var envelope struct {
		Step string `json:"step"`
	}
	if err := json.Unmarshal(message.Value, &envelope); err != nil {
		return quarantineSagaBindingCommand(ctx, client, message, reasonEnvelope)
	}
	if envelope.Step != sagaBindingAwaitStep {
		if knownSagaStep(envelope.Step) {
			return nil
		}
		return quarantineSagaBindingCommand(ctx, client, message, reasonType)
	}
	command, err := decodeBindingAwaitCommand(message.Key, message.Value)
	if err != nil {
		return quarantineSagaBindingCommand(ctx, client, message, reasonSchema)
	}
	err = retrySagaBindingRegistration(ctx, db, command)
	if err == nil {
		return nil
	}
	if !errors.Is(err, ErrSagaBindingCommandConflict) && !errors.Is(err, ErrInvalidEvent) {
		return err
	}
	return quarantineSagaBindingCommand(ctx, client, message, reasonConflict)
}

func retrySagaBindingRegistration(ctx context.Context, db TxStarter, command BindingAwaitCommand) error {
	work, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for attempt := 0; attempt < 5; attempt++ {
		err := RegisterBindingAwait(work, db, command)
		if err == nil || !transientBindingError(err) || attempt == 4 {
			return err
		}
		select {
		case <-work.Done():
			return work.Err()
		case <-time.After(time.Second):
		}
	}
	return nil
}

func knownSagaStep(step string) bool {
	switch step {
	case "asset.reserve", "asset.configure", "inventory.activate", sagaBindingAwaitStep, "inventory.deactivate", "asset.release":
		return true
	default:
		return false
	}
}

func quarantineSagaBindingCommand(ctx context.Context, client transport.Client, message transport.Message, reason string) error {
	record := bindingQuarantine(BindingMessage{Topic: message.Topic, Partition: message.Partition,
		Offset: message.Offset, Key: message.Key, Value: message.Value}, reason)
	return transport.Publish(ctx, client, record.Topic, record.Key, record.Value, nil)
}

func decodeBindingAwaitCommand(key, value []byte) (BindingAwaitCommand, error) {
	var wire struct {
		TenantID     string `json:"tenant_id"`
		SagaID       string `json:"saga_id"`
		CommandID    string `json:"command_id"`
		Step         string `json:"step"`
		SagaVersion  int64  `json:"saga_version"`
		FencingToken int64  `json:"fencing_token"`
		Payload      struct {
			DeviceID string `json:"device_id"`
		} `json:"payload"`
		Traceparent string `json:"traceparent"`
	}
	if err := json.Unmarshal(value, &wire); err != nil {
		return BindingAwaitCommand{}, err
	}
	if wire.Step != sagaBindingAwaitStep || string(key) != wire.TenantID+":"+wire.SagaID ||
		!isUUID(wire.TenantID) || !isUUID(wire.SagaID) || !isUUID(wire.CommandID) || !isUUID(wire.Payload.DeviceID) ||
		wire.SagaVersion < 1 || wire.FencingToken < 1 {
		return BindingAwaitCommand{}, ErrInvalidEvent
	}
	trace, _ := sanitizeTraceparent(wire.Traceparent)
	return BindingAwaitCommand{wire.TenantID, wire.SagaID, wire.CommandID, wire.Payload.DeviceID,
		wire.SagaVersion, wire.FencingToken, trace}, nil
}

// bindingResultHeaders copies an echoed saga trace into Kafka headers; an
// untraced result gets none rather than an invented context.
func bindingResultHeaders(value []byte) map[string]string {
	var r BindingResult
	if json.Unmarshal(value, &r) != nil || r.Traceparent == "" {
		return nil
	}
	return map[string]string{"traceparent": r.Traceparent, "correlation_id": r.SagaID, "tenant_id": r.TenantID}
}
