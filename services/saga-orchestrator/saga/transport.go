package saga

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
)

const (
	CommandTopic   = "greenguard.saga.commands.v1"
	ResultTopic    = "greenguard.saga.results.v1"
	ResultDLQTopic = "greenguard.saga.results.dlq.v1"
)

// Command is the stable wire identity of an outbox command. A crash after
// Kafka acknowledges but before published_at commits can publish it again;
// participants must deduplicate by (tenant_id, command_id).
type Command struct {
	TenantID     string          `json:"tenant_id"`
	SagaID       string          `json:"saga_id"`
	CommandID    string          `json:"command_id"`
	Step         string          `json:"step"`
	SagaVersion  int64           `json:"saga_version"`
	FencingToken int64           `json:"fencing_token"`
	Payload      json.RawMessage `json:"payload"`
	// CorrelationID is the saga ID; Traceparent is the saga's stored W3C context
	// (propagated from the start request, or one generated root per saga).
	// Participants ignore unknown fields, so these are additive to the contract.
	CorrelationID string `json:"correlation_id"`
	Traceparent   string `json:"traceparent"`
}

// PublishCommand is called while the selected outbox row is locked. It must
// return only after an all-ISR broker acknowledgement, never after enqueueing
// locally. The transaction commits published_at only after that acknowledgement.
type PublishCommand func(context.Context, []byte, []byte) error

// PublishNextCommand publishes at most one tenant-scoped pending command. The
// row lock prevents two workers from publishing the same row concurrently.
// An ambiguous publish/commit boundary deliberately leaves at-least-once
// delivery, covered by the participant's durable command receipt.
func (s Store) PublishNextCommand(ctx context.Context, tenantID string, publish PublishCommand) (bool, error) {
	if !common.TenantPattern.MatchString(tenantID) || publish == nil {
		return false, ErrInvalidRequest
	}
	var sent bool
	err := common.WithTenantSchema(ctx, s.DB, tenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		if err := s.fence(ctx, tx, tenantID); err != nil {
			return err
		}
		command := Command{TenantID: tenantID}
		var trace *string
		err := tx.QueryRow(ctx, `SELECT saga_id, command_id, step, saga_version, fencing_token, payload, traceparent
			FROM saga_command_outbox WHERE tenant_id=$1 AND published_at IS NULL
			ORDER BY created_at, command_id FOR UPDATE SKIP LOCKED LIMIT 1`, tenantID).Scan(
			&command.SagaID, &command.CommandID, &command.Step, &command.SagaVersion,
			&command.FencingToken, &command.Payload, &trace)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("select saga command: %w", err)
		}
		command.CorrelationID = command.SagaID
		var ready bool
		if command.Traceparent, ready, err = commandTrace(ctx, tx, command, trace); err != nil || !ready {
			return err
		}
		value, err := json.Marshal(command)
		if err != nil {
			return fmt.Errorf("encode saga command: %w", err)
		}
		if err := publish(ctx, []byte(tenantID+":"+command.SagaID), value); err != nil {
			return fmt.Errorf("publish saga command: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE saga_command_outbox SET published_at=now()
			WHERE tenant_id=$1 AND command_id=$2 AND published_at IS NULL`, tenantID, command.CommandID); err != nil {
			return fmt.Errorf("mark saga command published: %w", err)
		}
		sent = true
		return nil
	})
	return sent && err == nil, err
}

// Result is the result-topic contract. Step is checked for a known value, but
// the authoritative command step/version/fence are looked up in Postgres by
// ApplyStepResult before any state transition.
type Result struct {
	StepResult
	Step string `json:"step"`
}

func (r Result) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		TenantID     string `json:"tenant_id"`
		SagaID       string `json:"saga_id"`
		CommandID    string `json:"command_id"`
		ResultID     string `json:"result_id"`
		Step         string `json:"step"`
		SagaVersion  int64  `json:"saga_version"`
		FencingToken int64  `json:"fencing_token"`
		Outcome      string `json:"outcome"`
	}{r.TenantID, r.SagaID, r.CommandID, r.ResultID, r.Step,
		r.SagaVersion, r.FencingToken, r.Outcome})
}

// DecodeResult rejects malformed or surprising events before they reach the
// tenant transaction. The database still verifies command identity and fence.
func DecodeResult(value, key []byte) (Result, error) {
	var wire struct {
		TenantID     string `json:"tenant_id"`
		SagaID       string `json:"saga_id"`
		CommandID    string `json:"command_id"`
		ResultID     string `json:"result_id"`
		Step         string `json:"step"`
		SagaVersion  int64  `json:"saga_version"`
		FencingToken int64  `json:"fencing_token"`
		Outcome      string `json:"outcome"`
	}
	if err := json.Unmarshal(value, &wire); err != nil {
		return Result{}, fmt.Errorf("%w: decode saga result: %v", ErrInvalidRequest, err)
	}
	if !common.TenantPattern.MatchString(wire.TenantID) ||
		!common.TenantPattern.MatchString(wire.SagaID) ||
		!common.TenantPattern.MatchString(wire.CommandID) ||
		!common.TenantPattern.MatchString(wire.ResultID) ||
		string(key) != wire.TenantID+":"+wire.SagaID ||
		wire.SagaVersion < 1 || wire.FencingToken < 1 ||
		(wire.Outcome != "succeeded" && wire.Outcome != "rejected") {
		return Result{}, ErrInvalidRequest
	}
	if _, ok := routes[wire.Step]; !ok {
		return Result{}, ErrInvalidRequest
	}
	return Result{StepResult: StepResult{TenantID: wire.TenantID, SagaID: wire.SagaID,
		CommandID: wire.CommandID, ResultID: wire.ResultID, SagaVersion: wire.SagaVersion,
		FencingToken: wire.FencingToken, Outcome: wire.Outcome}, Step: wire.Step}, nil
}

// ApplyResultRecord is safe to invoke again before committing the Kafka
// offset: ApplyStepResult deduplicates a previously committed command receipt.
func (s Store) ApplyResultRecord(ctx context.Context, key, value []byte) (Snapshot, error) {
	result, err := DecodeResult(value, key)
	if err != nil {
		return Snapshot{}, err
	}
	result.StepResult.ExpectedStep = result.Step
	return s.ApplyStepResult(ctx, result.StepResult)
}
