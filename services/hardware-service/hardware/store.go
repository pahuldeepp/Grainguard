// Package hardware owns pre-registered physical sensor assets and saga command receipts.
package hardware

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
)

var (
	ErrInvalidCommand   = errors.New("invalid hardware command")
	ErrCommandConflict  = errors.New("command id reused with different request")
	ErrStaleCommand     = errors.New("stale fencing token")
	ErrMissingAckSecret = errors.New("device acknowledgement key is missing or too short")
)

const (
	hardwareStepReserve   = "asset.reserve"
	hardwareStepConfigure = "asset.configure"
	hardwareStepRelease   = "asset.release"
)

type Command struct {
	TenantID     string `json:"tenant_id"`
	SagaID       string `json:"saga_id"`
	CommandID    string `json:"command_id"`
	Step         string `json:"step"`
	SagaVersion  int64  `json:"saga_version"`
	FencingToken int64  `json:"fencing_token"`
	Payload      struct {
		TenantID string `json:"tenant_id"`
		SagaID   string `json:"saga_id"`
		DeviceID string `json:"device_id"`
		AssetID  string `json:"asset_id"`
	} `json:"payload"`
	// Traceparent is the saga's trace context; it is not part of the identity hash.
	Traceparent string `json:"traceparent,omitempty"`
}

type Result struct {
	TenantID     string `json:"tenant_id"`
	SagaID       string `json:"saga_id"`
	CommandID    string `json:"command_id"`
	ResultID     string `json:"result_id"`
	Step         string `json:"step"`
	SagaVersion  int64  `json:"saga_version"`
	FencingToken int64  `json:"fencing_token"`
	Outcome      string `json:"outcome"`
	Traceparent  string `json:"-"` // Kafka header only
}

type Store struct{ DB common.TxStarter }

func valid(c Command) bool {
	return common.TenantPattern.MatchString(c.TenantID) &&
		common.TenantPattern.MatchString(c.SagaID) &&
		common.TenantPattern.MatchString(c.CommandID) &&
		common.TenantPattern.MatchString(c.Payload.DeviceID) &&
		common.TenantPattern.MatchString(c.Payload.AssetID) &&
		c.Payload.TenantID == c.TenantID && c.Payload.SagaID == c.SagaID &&
		c.SagaVersion > 0 && c.FencingToken > 0 &&
		(c.Step == hardwareStepReserve || c.Step == hardwareStepConfigure || c.Step == hardwareStepRelease)
}

// Apply records the physical state change, command receipt, and result outbox
// atomically. The row lock serializes concurrent claims and release/configure.
// A transient database error never becomes a business rejection.
func (s Store) Apply(ctx context.Context, c Command) (Result, error) {
	if !valid(c) {
		return Result{}, ErrInvalidCommand
	}
	c.Traceparent = commandTrace(c)
	hash := requestHash(c)
	var result Result
	var err error
	err = common.WithTenantSchema(ctx, s.DB, c.TenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		var err error
		result, err = applyTx(ctx, tx, c, hash[:])
		return err
	})
	return result, err
}

func applyTx(ctx context.Context, tx pgx.Tx, c Command, hash []byte) (Result, error) {
	// Serialize duplicate deliveries before reading the receipt. Row locks alone
	// cannot protect a missing receipt from two concurrent consumers.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, c.TenantID+":"+c.CommandID); err != nil {
		return Result{}, fmt.Errorf("lock command: %w", err)
	}
	if existing, found, err := existingReceipt(ctx, tx, c, hash); err != nil || found {
		return existing, err
	}
	status, err := decideStatus(ctx, tx, c)
	if err != nil {
		return Result{}, err
	}
	var id string
	err = tx.QueryRow(ctx, `INSERT INTO hardware_command_receipts
		(tenant_id,command_id,saga_id,step,saga_version,fencing_token,request_hash,outcome,request_payload)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING result_id`,
		c.TenantID, c.CommandID, c.SagaID, c.Step, c.SagaVersion, c.FencingToken, hash, status, string(dataFor(c))).Scan(&id)
	if err != nil {
		return Result{}, fmt.Errorf("insert receipt: %w", err)
	}
	result := resultFor(c, id, status)
	if status == "pending" {
		return result, nil
	}
	_, err = tx.Exec(ctx, `INSERT INTO hardware_result_outbox
		(tenant_id,result_id,command_id,saga_id,step,saga_version,fencing_token,outcome,traceparent)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''))`, c.TenantID, id, c.CommandID, c.SagaID, c.Step, c.SagaVersion, c.FencingToken, status, c.Traceparent)
	if err != nil {
		return Result{}, fmt.Errorf("insert result: %w", err)
	}
	return result, nil
}

// existingReceipt returns the stored result for a replayed command, or found=false.
func existingReceipt(ctx context.Context, tx pgx.Tx, c Command, hash []byte) (Result, bool, error) {
	var existing Result
	var storedHash []byte
	err := tx.QueryRow(ctx, `SELECT request_hash,result_id,outcome FROM hardware_command_receipts
		WHERE tenant_id=$1 AND command_id=$2`, c.TenantID, c.CommandID).Scan(&storedHash, &existing.ResultID, &existing.Outcome)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, false, nil
	}
	if err != nil {
		return Result{}, false, fmt.Errorf("read receipt: %w", err)
	}
	if string(storedHash) != string(hash) {
		return Result{}, false, ErrCommandConflict
	}
	return resultFor(c, existing.ResultID, existing.Outcome), true, nil
}

// decideStatus locks the asset row (FOR UPDATE) and applies the command when allowed.
func decideStatus(ctx context.Context, tx pgx.Tx, c Command) (string, error) {
	var state, owner, device string
	var fence int64
	err := tx.QueryRow(ctx, `SELECT state,COALESCE(owner_saga_id::text,''),COALESCE(device_id::text,''),fencing_token
		FROM hardware_assets WHERE tenant_id=$1 AND asset_id=$2 FOR UPDATE`, c.TenantID, c.Payload.AssetID).Scan(&state, &owner, &device, &fence)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("lock asset: %w", err)
	}
	if state != "available" && owner == c.SagaID && fence > c.FencingToken {
		return "", ErrStaleCommand
	}
	if err != nil || !allowed(c, state, owner, device) {
		return "rejected", nil
	}
	if c.Step == hardwareStepConfigure {
		if _, err := tx.Exec(ctx, `UPDATE hardware_assets SET fencing_token=$3,updated_at=now()
			WHERE tenant_id=$1 AND asset_id=$2`, c.TenantID, c.Payload.AssetID, c.FencingToken); err != nil {
			return "", fmt.Errorf("advance hardware fencing token: %w", err)
		}
		return "pending", nil
	}
	if err := updateAsset(ctx, tx, c); err != nil {
		return "", err
	}
	if err := cancelPendingConfigure(ctx, tx, c); err != nil {
		return "", err
	}
	return "succeeded", nil
}

func allowed(c Command, state, owner, device string) bool {
	switch c.Step {
	case hardwareStepReserve:
		return state == "available"
	case hardwareStepConfigure:
		return state == "reserved" && owner == c.SagaID && device == c.Payload.DeviceID
	case hardwareStepRelease:
		return state == "available" || (owner == c.SagaID && device == c.Payload.DeviceID)
	}
	return false
}

func updateAsset(ctx context.Context, tx pgx.Tx, c Command) error {
	var query string
	var args []any
	switch c.Step {
	case hardwareStepReserve:
		query = `UPDATE hardware_assets SET state='reserved',owner_saga_id=$3,device_id=$4,fencing_token=$5,updated_at=now() WHERE tenant_id=$1 AND asset_id=$2`
		args = []any{c.TenantID, c.Payload.AssetID, c.SagaID, c.Payload.DeviceID, c.FencingToken}
	case hardwareStepRelease:
		query = `UPDATE hardware_assets SET state='available',owner_saga_id=NULL,device_id=NULL,fencing_token=0,updated_at=now() WHERE tenant_id=$1 AND asset_id=$2`
		args = []any{c.TenantID, c.Payload.AssetID}
	}
	if _, err := tx.Exec(ctx, query, args...); err != nil {
		return fmt.Errorf("update hardware: %w", err)
	}
	return nil
}

func resultFor(c Command, id, outcome string) Result {
	return Result{TenantID: c.TenantID, SagaID: c.SagaID, CommandID: c.CommandID, ResultID: id, Step: c.Step, SagaVersion: c.SagaVersion, FencingToken: c.FencingToken, Outcome: outcome, Traceparent: commandTrace(c)}
}

// MarkPublished records broker acknowledgement; replay still publishes the
// stable result ID before committing the command offset.
func (s Store) MarkPublished(ctx context.Context, result Result) error {
	return common.WithTenantSchema(ctx, s.DB, result.TenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE hardware_result_outbox SET published_at=COALESCE(published_at,now())
			WHERE tenant_id=$1 AND result_id=$2 AND command_id=$3`, result.TenantID, result.ResultID, result.CommandID)
		return err
	})
}

// ConfigureSecret reads the asset-specific acknowledgement key only while this
// command still owns a reserved asset. It is never sent to Kafka or MQTT.
func (s Store) ConfigureSecret(ctx context.Context, c Command) ([]byte, error) {
	var secret []byte
	err := common.WithTenantSchema(ctx, s.DB, c.TenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT mqtt_ack_secret FROM hardware_assets WHERE tenant_id=$1 AND asset_id=$2
			AND owner_saga_id=$3 AND device_id=$4 AND state='reserved' AND fencing_token=$5`,
			c.TenantID, c.Payload.AssetID, c.SagaID, c.Payload.DeviceID, c.FencingToken).Scan(&secret)
	})
	if err != nil {
		return nil, fmt.Errorf("read configure key: %w", err)
	}
	if len(secret) < 32 {
		return nil, ErrMissingAckSecret
	}
	return secret, nil
}

// ConfirmConfiguration atomically validates that an outstanding receipt is still
// current, marks the asset configured, and creates the result for Kafka. A replay
// of the same acknowledgement yields the same result ID.
func (s Store) ConfirmConfiguration(ctx context.Context, c Command, attestedSecret []byte) (Result, error) {
	if c.Step != hardwareStepConfigure || !valid(c) {
		return Result{}, ErrInvalidCommand
	}
	var result Result
	err := common.WithTenantSchema(ctx, s.DB, c.TenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		var state, owner, device string
		var fence int64
		var secret []byte
		assetErr := tx.QueryRow(ctx, `SELECT state,COALESCE(owner_saga_id::text,''),COALESCE(device_id::text,''),fencing_token,mqtt_ack_secret
			FROM hardware_assets WHERE tenant_id=$1 AND asset_id=$2 FOR UPDATE`, c.TenantID, c.Payload.AssetID).
			Scan(&state, &owner, &device, &fence, &secret)
		if errors.Is(assetErr, pgx.ErrNoRows) {
			return ErrStaleCommand
		}
		if assetErr != nil {
			return fmt.Errorf("lock hardware asset for acknowledgement: %w", assetErr)
		}
		var outcome string
		var id string
		err := tx.QueryRow(ctx, `SELECT result_id,outcome FROM hardware_command_receipts
			WHERE tenant_id=$1 AND command_id=$2 AND saga_id=$3 AND step=$4 AND saga_version=$5 AND fencing_token=$6 FOR UPDATE`,
			c.TenantID, c.CommandID, c.SagaID, c.Step, c.SagaVersion, c.FencingToken).Scan(&id, &outcome)
		if err != nil {
			return err
		}
		result = resultFor(c, id, outcome)
		if outcome == "succeeded" {
			return nil
		}
		if outcome != "pending" {
			return ErrStaleCommand
		}
		if state != "reserved" || owner != c.SagaID || device != c.Payload.DeviceID || fence != c.FencingToken ||
			len(secret) < 32 || !EqualMAC(secret, attestedSecret) {
			return ErrStaleCommand
		}
		if _, err = tx.Exec(ctx, `UPDATE hardware_assets SET state='configured',updated_at=now() WHERE tenant_id=$1 AND asset_id=$2`, c.TenantID, c.Payload.AssetID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE hardware_command_receipts SET outcome='succeeded' WHERE tenant_id=$1 AND command_id=$2`, c.TenantID, c.CommandID); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO hardware_result_outbox(tenant_id,result_id,command_id,saga_id,step,saga_version,fencing_token,outcome,traceparent)
			VALUES($1,$2,$3,$4,$5,$6,$7,'succeeded',NULLIF($8,'')) ON CONFLICT (tenant_id,result_id) DO NOTHING`,
			c.TenantID, id, c.CommandID, c.SagaID, c.Step, c.SagaVersion, c.FencingToken, commandTrace(c))
		result.Outcome = "succeeded"
		return err
	})
	return result, err
}

// EqualMAC compares the device attestation without leaking a prefix match.
func EqualMAC(expected, actual []byte) bool { return subtle.ConstantTimeCompare(expected, actual) == 1 }

func dataFor(c Command) []byte { b, _ := json.Marshal(c); return b }

// cancelPendingConfigure finalizes an outstanding configure receipt of the saga
// in the same transaction that releases its asset. A released asset cannot be
// configured, so the receipt must never be dispatched again.
func cancelPendingConfigure(ctx context.Context, tx pgx.Tx, c Command) error {
	if c.Step != hardwareStepRelease {
		return nil
	}
	_, err := tx.Exec(ctx, `UPDATE hardware_command_receipts SET outcome='cancelled'
		WHERE tenant_id=$1 AND saga_id=$2 AND step='asset.configure' AND outcome='pending'`, c.TenantID, c.SagaID)
	if err != nil {
		return fmt.Errorf("cancel pending configure: %w", err)
	}
	return nil
}

// MaxDispatchBatch bounds one dispatcher pass; the selector clamps to it too.
const MaxDispatchBatch = 100

// Dispatch is a claimed configuration plus its per-asset acknowledgement key.
type Dispatch struct {
	Command Command
	Secret  []byte
}

// ClaimPendingConfigurations fetches only immutable identifiers globally, in
// least-recently-dispatched order, then claims each receipt inside its own
// tenant RLS transaction with FOR UPDATE SKIP LOCKED. A claimed receipt moves to
// the back of the queue, so blocked receipts cannot starve newer ones. A receipt
// whose asset is no longer reserved by its saga is cancelled, never retried.
func (s Store) ClaimPendingConfigurations(ctx context.Context, limit int) ([]Dispatch, error) {
	if limit <= 0 || limit > MaxDispatchBatch {
		limit = MaxDispatchBatch
	}
	keys, err := s.idPairs(ctx, `SELECT tenant_id,command_id FROM hardware_pending_configuration_ids($1)`, limit)
	if err != nil {
		return nil, err
	}
	var claimed []Dispatch
	for _, key := range keys {
		var d *Dispatch
		err = common.WithTenantSchema(ctx, s.DB, key[0], "", func(ctx context.Context, tx pgx.Tx) error {
			var err error
			d, err = claimTx(ctx, tx, key[0], key[1])
			return err
		})
		if errors.Is(err, common.ErrTenantQuiescing) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if d != nil {
			claimed = append(claimed, *d)
		}
	}
	return claimed, nil
}

func claimTx(ctx context.Context, tx pgx.Tx, tenant, commandID string) (*Dispatch, error) {
	var data []byte
	err := tx.QueryRow(ctx, `SELECT request_payload FROM hardware_command_receipts
		WHERE tenant_id=$1 AND command_id=$2 AND step='asset.configure' AND outcome='pending'
		FOR UPDATE SKIP LOCKED`, tenant, commandID).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("claim configure: %w", err)
	}
	var c Command
	if err = json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	var secret []byte
	var owned bool
	err = tx.QueryRow(ctx, `SELECT mqtt_ack_secret,(state='reserved' AND owner_saga_id=$3 AND device_id=$4 AND fencing_token=$5)
		FROM hardware_assets WHERE tenant_id=$1 AND asset_id=$2`,
		tenant, c.Payload.AssetID, c.SagaID, c.Payload.DeviceID, c.FencingToken).Scan(&secret, &owned)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("read configure asset: %w", err)
	}
	if !owned {
		_, err = tx.Exec(ctx, `UPDATE hardware_command_receipts SET outcome='cancelled' WHERE tenant_id=$1 AND command_id=$2`, tenant, commandID)
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE hardware_command_receipts SET last_dispatched_at=clock_timestamp() WHERE tenant_id=$1 AND command_id=$2`, tenant, commandID); err != nil {
		return nil, err
	}
	return &Dispatch{Command: c, Secret: secret}, nil
}

// idPairs runs an ID-only SECURITY DEFINER selector and returns its key pairs.
func (s Store) idPairs(ctx context.Context, query string, args ...any) ([][2]string, error) {
	if shards, ok := s.DB.(*common.ShardedDB); ok {
		var keys [][2]string
		err := shards.ForEachPrimary(ctx, func(shard string, _ *pgxpool.Pool) error {
			tx, err := shards.InfrastructureDB(shard).BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
			if err != nil {
				return err
			}
			defer common.Rollback(tx)
			rows, err := tx.Query(ctx, query, args...)
			if err != nil {
				return err
			}
			page, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) ([2]string, error) {
				var key [2]string
				err := row.Scan(&key[0], &key[1])
				return key, err
			})
			keys = append(keys, page...)
			if err != nil {
				return err
			}
			return tx.Commit(ctx)
		})
		return keys, err
	}
	db, ok := s.DB.(interface {
		Query(context.Context, string, ...any) (pgx.Rows, error)
	})
	if !ok {
		return nil, errors.New("id scan requires query-capable pool")
	}
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var keys [][2]string
	for rows.Next() {
		var key [2]string
		if err = rows.Scan(&key[0], &key[1]); err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

// PendingCommand looks up an acknowledgement's exact tenant/command pair under RLS.
func (s Store) PendingCommand(ctx context.Context, tenant, commandID string) (Command, error) {
	var c Command
	var data []byte
	err := common.WithTenantSchema(ctx, s.DB, tenant, "", func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT request_payload FROM hardware_command_receipts WHERE tenant_id=$1 AND command_id=$2 AND step='asset.configure' AND outcome='pending'`, tenant, commandID).Scan(&data)
	})
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(data, &c)
	return c, err
}

// UnpublishedResults recovers a crash after a device ack but before Kafka
// publication. It returns immutable identities globally and loads each result
// in a tenant-scoped transaction.
func (s Store) UnpublishedResults(ctx context.Context) ([]Result, error) {
	keys, err := s.idPairs(ctx, `SELECT tenant_id,result_id FROM hardware_unpublished_result_ids()`)
	if err != nil {
		return nil, err
	}
	var results []Result
	for _, k := range keys {
		var r Result
		err = common.WithTenantSchema(ctx, s.DB, k[0], "", func(ctx context.Context, tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT tenant_id,saga_id,command_id,result_id,step,saga_version,fencing_token,outcome,COALESCE(traceparent,'') FROM hardware_result_outbox WHERE tenant_id=$1 AND result_id=$2 AND published_at IS NULL`, k[0], k[1]).Scan(&r.TenantID, &r.SagaID, &r.CommandID, &r.ResultID, &r.Step, &r.SagaVersion, &r.FencingToken, &r.Outcome, &r.Traceparent)
		})
		if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, common.ErrTenantQuiescing) {
			continue
		}
		if err != nil {
			return nil, err
		}
		results = append(results, r)
	}
	return results, nil
}
