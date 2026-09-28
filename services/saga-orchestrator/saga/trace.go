package saga

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Trace origins recorded on the saga row and in its audit reason.
const (
	TraceOriginPropagated = "propagated"
	TraceOriginGenerated  = "generated"
)

var traceparentPattern = regexp.MustCompile(`^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$`)

// SanitizeTraceparent accepts only a version-00 W3C traceparent with non-zero
// trace and parent IDs, keeps the sampled bit and drops every other flag. The
// tracestate header is ignored, as in telemetry-ingest and device-service.
func SanitizeTraceparent(value string) (string, bool) {
	m := traceparentPattern.FindStringSubmatch(value)
	if m == nil || strings.Trim(m[1], "0") == "" || strings.Trim(m[2], "0") == "" {
		return "", false
	}
	flags, _ := hex.DecodeString(m[3])
	suffix := "00"
	if flags[0]&1 == 1 {
		suffix = "01"
	}
	return "00-" + m[1] + "-" + m[2] + "-" + suffix, true
}

// NewRootTraceparent starts a new sampled root trace from random IDs. It is
// used once per saga that has no propagated context; it never derives IDs from
// saga or command identifiers.
func NewRootTraceparent() string {
	ids := make([]byte, 24)
	if _, err := rand.Read(ids); err != nil {
		panic(fmt.Sprintf("saga: random trace id: %v", err))
	}
	ids[0] |= 1 // never an all-zero trace ID
	ids[16] |= 1
	return "00-" + hex.EncodeToString(ids[:16]) + "-" + hex.EncodeToString(ids[16:]) + "-01"
}

// startTrace resolves the start request's context: a valid caller value is
// propagated, anything else starts a new root trace.
func startTrace(header string) (string, string) {
	if tp, ok := SanitizeTraceparent(header); ok {
		return tp, TraceOriginPropagated
	}
	return NewRootTraceparent(), TraceOriginGenerated
}

// ensureSagaTrace returns the saga's stored traceparent, generating and storing
// one root trace if the row has none. Callers must hold the saga row lock.
func ensureSagaTrace(ctx context.Context, tx pgx.Tx, tenantID, sagaID string, version int64) (string, error) {
	var tp string
	err := tx.QueryRow(ctx, `UPDATE provisioning_sagas SET traceparent=$3, trace_origin='generated'
		WHERE tenant_id=$1 AND saga_id=$2 AND traceparent IS NULL RETURNING traceparent`,
		tenantID, sagaID, NewRootTraceparent()).Scan(&tp)
	if err == nil {
		slog.Info("saga trace generated", "saga_id", sagaID, "trace_origin", TraceOriginGenerated)
		return tp, audit(ctx, tx, tenantID, sagaID, version, "trace.generated", "trace_origin="+TraceOriginGenerated)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("store saga trace: %w", err)
	}
	if err := tx.QueryRow(ctx, `SELECT traceparent FROM provisioning_sagas WHERE tenant_id=$1 AND saga_id=$2`,
		tenantID, sagaID).Scan(&tp); err != nil {
		return "", fmt.Errorf("read saga trace: %w", err)
	}
	return tp, nil
}

// commandTrace returns the stored context of a selected command, filling a
// pre-migration row through legacyCommandTrace.
func commandTrace(ctx context.Context, tx pgx.Tx, command Command, stored *string) (string, bool, error) {
	if stored != nil {
		return *stored, true, nil
	}
	return legacyCommandTrace(ctx, tx, command)
}

// legacyCommandTrace fills the context of a command queued before migration
// 000007. It takes the saga row lock with SKIP LOCKED so the publisher never
// waits behind a transition (which locks saga, then outbox); ok=false means
// "retry on a later pass".
func legacyCommandTrace(ctx context.Context, tx pgx.Tx, command Command) (string, bool, error) {
	var locked string
	err := tx.QueryRow(ctx, `SELECT saga_id FROM provisioning_sagas WHERE tenant_id=$1 AND saga_id=$2
		FOR UPDATE SKIP LOCKED`, command.TenantID, command.SagaID).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("lock saga trace: %w", err)
	}
	tp, err := ensureSagaTrace(ctx, tx, command.TenantID, command.SagaID, command.SagaVersion)
	if err != nil {
		return "", false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE saga_command_outbox SET traceparent=$3 WHERE tenant_id=$1 AND command_id=$2`,
		command.TenantID, command.CommandID, tp); err != nil {
		return "", false, fmt.Errorf("store command trace: %w", err)
	}
	return tp, true, nil
}
