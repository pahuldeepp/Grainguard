// Package saga owns the durable provisioning state and command outbox.
package saga

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	common "greenguard.local/go-common"
)

var (
	ErrInvalidRequest      = errors.New("invalid provisioning request")
	ErrIdempotencyConflict = errors.New("idempotency key belongs to another request")
	ErrAssetClaimed        = errors.New("asset already has an active provisioning claim")
)

type StartRequest struct {
	TenantID       string
	IdempotencyKey string
	DeviceID       string
	AssetID        string
	// Traceparent is the caller's W3C header. It is not part of the request
	// hash: a retry under another trace returns the original saga and trace.
	Traceparent string
}

type Snapshot struct {
	TenantID     string
	SagaID       string
	DeviceID     string
	AssetID      string
	State        string
	Version      int64
	FencingToken int64
	DeadlineAt   time.Time
}

// Store is the saga authority. Fence, when set, is checked in every scanning
// side-effect transaction (command publication and deadline compensation).
type Store struct {
	DB    common.TxStarter
	Fence Fencer
}

func validate(req StartRequest) error {
	if !common.TenantPattern.MatchString(req.TenantID) ||
		!common.TenantPattern.MatchString(req.DeviceID) ||
		!common.TenantPattern.MatchString(req.AssetID) ||
		len(req.IdempotencyKey) < 1 || len(req.IdempotencyKey) > 128 ||
		strings.TrimSpace(req.IdempotencyKey) != req.IdempotencyKey ||
		strings.ContainsAny(req.IdempotencyKey, "\r\n\x00") {
		return ErrInvalidRequest
	}
	return nil
}

// Start atomically claims an asset, records the saga and writes its first command.
// A retry with the same key and request returns the original snapshot. The unique
// asset index arbitrates concurrent claims, independent of application locks.
func (s Store) Start(ctx context.Context, req StartRequest) (Snapshot, error) {
	if err := validate(req); err != nil {
		return Snapshot{}, err
	}
	hash := sha256.Sum256([]byte(req.DeviceID + "\x00" + req.AssetID))
	trace, origin := startTrace(req.Traceparent)
	req.Traceparent = trace
	for attempt := 0; attempt < 2; attempt++ {
		snap, err := s.startOnce(ctx, req, hash, origin)
		if err == nil || !errors.Is(err, ErrAssetClaimed) || attempt == 1 {
			return snap, err
		}
	}
	return Snapshot{}, ErrAssetClaimed
}

func (s Store) startOnce(ctx context.Context, req StartRequest, hash [32]byte, origin string) (Snapshot, error) {
	var snap Snapshot
	err := common.WithTenantSchema(ctx, s.DB, req.TenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		var err error
		snap, err = startInTx(ctx, tx, req, hash, origin)
		return err
	})
	if err != nil {
		return Snapshot{}, err
	}
	return snap, nil
}

func startInTx(ctx context.Context, tx pgx.Tx, req StartRequest, hash [32]byte, origin string) (Snapshot, error) {
	inserted, err := insertSaga(ctx, tx, req, hash, origin)
	if err != nil {
		return Snapshot{}, err
	}
	snap, storedHash, err := readSaga(ctx, tx, req)
	if err != nil {
		return Snapshot{}, err
	}
	if string(storedHash) != string(hash[:]) {
		return Snapshot{}, ErrIdempotencyConflict
	}
	if inserted {
		if err := queueStartEffects(ctx, tx, req, snap.SagaID, origin); err != nil {
			return Snapshot{}, err
		}
	}
	return snap, nil
}

func insertSaga(ctx context.Context, tx pgx.Tx, req StartRequest, hash [32]byte, origin string) (bool, error) {
	var insertedID string
	err := tx.QueryRow(ctx, `INSERT INTO provisioning_sagas
			(tenant_id, idempotency_key, request_hash, device_id, asset_id, deadline_at, traceparent, trace_origin)
			VALUES ($1, $2, $3, $4, $5, now() + interval '15 minutes', $6, $7)
			ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING saga_id`,
		req.TenantID, req.IdempotencyKey, hash[:], req.DeviceID, req.AssetID, req.Traceparent, origin).Scan(&insertedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "provisioning_asset_claim" {
			return false, ErrAssetClaimed
		}
		return false, fmt.Errorf("insert saga: %w", err)
	}
	return true, nil
}

func readSaga(ctx context.Context, tx pgx.Tx, req StartRequest) (Snapshot, []byte, error) {
	snap := Snapshot{TenantID: req.TenantID}
	var storedHash []byte
	if err := tx.QueryRow(ctx, `SELECT saga_id, device_id, asset_id, state, version,
			fencing_token, deadline_at, request_hash FROM provisioning_sagas
			WHERE tenant_id=$1 AND idempotency_key=$2`, req.TenantID, req.IdempotencyKey).Scan(
		&snap.SagaID, &snap.DeviceID, &snap.AssetID, &snap.State, &snap.Version,
		&snap.FencingToken, &snap.DeadlineAt, &storedHash); err != nil {
		return Snapshot{}, nil, fmt.Errorf("read saga: %w", err)
	}
	return snap, storedHash, nil
}

func queueStartEffects(ctx context.Context, tx pgx.Tx, req StartRequest, sagaID, origin string) error {
	if _, err := tx.Exec(ctx, `INSERT INTO saga_command_outbox
			(tenant_id, saga_id, step, saga_version, fencing_token, payload, traceparent)
			VALUES ($1, $2, 'asset.reserve', 1, 1,
			jsonb_build_object('tenant_id', ($1::uuid)::text, 'saga_id', ($2::uuid)::text,
			'device_id', ($3::uuid)::text, 'asset_id', ($4::uuid)::text), $5)`,
		req.TenantID, sagaID, req.DeviceID, req.AssetID, req.Traceparent); err != nil {
		return fmt.Errorf("insert reserve command: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO saga_audit
			(tenant_id, saga_id, version, action, reason) VALUES ($1, $2, 1, 'provisioning.requested', $3)`,
		req.TenantID, sagaID, "trace_origin="+origin); err != nil {
		return fmt.Errorf("insert audit: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO saga_dispatch_tenants (tenant_id, shard)
			VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`, req.TenantID, ShardFor(req.TenantID)); err != nil {
		return fmt.Errorf("register dispatch tenant: %w", err)
	}
	return nil
}
