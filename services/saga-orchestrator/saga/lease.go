package saga

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
)

// ShardCount is fixed by migration 000005; changing it requires a resharding ADR.
const ShardCount = 64

var ErrLeaseLost = errors.New("worker shard lease lost or superseded")

// ShardFor must match the SQL backfill: first SHA-256 byte of the tenant text mod 64.
func ShardFor(tenantID string) int {
	sum := sha256.Sum256([]byte(tenantID))
	return int(sum[0]) % ShardCount
}

// Fencer is checked inside the same transaction as every fenced side effect.
type Fencer interface {
	Check(ctx context.Context, tx pgx.Tx, tenantID string) error
}

// Leases is one worker's bounded set of shard leases (ADR-0013). PostgreSQL
// remains the authority: a lease only decides which worker scans a shard.
type Leases struct {
	DB        common.TxStarter
	Holder    string
	TTL       time.Duration
	MaxShards int

	mu   sync.Mutex
	held map[int]int64
}

// Renew extends held leases and takes free or expired shards up to MaxShards in
// one statement. A shard that is not returned is no longer owned. The token is
// kept on renewal and incremented on every takeover, including re-acquisition
// by the same holder after expiry.
func (l *Leases) Renew(ctx context.Context) (map[int]int64, error) {
	if l.Holder == "" || l.TTL < time.Second || l.MaxShards < 1 || l.MaxShards > ShardCount {
		return nil, ErrInvalidRequest
	}
	next := make(map[int]int64)
	tx, err := l.DB.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin lease renewal: %w", err)
	}
	defer func() { _ = common.Rollback(tx) }()
	rows, err := tx.Query(ctx, `WITH mine AS (
			SELECT shard FROM saga_shard_leases WHERE holder=$1 AND expires_at > clock_timestamp()
		), free AS (
			SELECT shard FROM saga_shard_leases WHERE expires_at <= clock_timestamp()
			ORDER BY shard LIMIT GREATEST($3 - (SELECT count(*) FROM mine), 0)
			FOR UPDATE SKIP LOCKED
		)
		UPDATE saga_shard_leases l SET
			fencing_token = CASE WHEN l.holder=$1 AND l.expires_at > clock_timestamp()
				THEN l.fencing_token ELSE l.fencing_token + 1 END,
			holder=$1, expires_at = clock_timestamp() + make_interval(secs => $2)
		WHERE l.shard IN (SELECT shard FROM mine UNION SELECT shard FROM free)
			AND ((l.holder=$1 AND l.expires_at > clock_timestamp()) OR l.expires_at <= clock_timestamp())
		RETURNING l.shard, l.fencing_token`, l.Holder, l.TTL.Seconds(), l.MaxShards)
	if err != nil {
		return nil, fmt.Errorf("renew leases: %w", err)
	}
	for rows.Next() {
		var shard int
		var token int64
		if err := rows.Scan(&shard, &token); err != nil {
			rows.Close()
			return nil, err
		}
		next[shard] = token
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit lease renewal: %w", err)
	}
	l.mu.Lock()
	l.held = next
	l.mu.Unlock()
	return copyLeases(next), nil
}

// Held returns a snapshot of the leases this process believes it owns.
func (l *Leases) Held() map[int]int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return copyLeases(l.held)
}

func copyLeases(in map[int]int64) map[int]int64 {
	out := make(map[int]int64, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// Release expires held leases on graceful shutdown without resetting tokens.
func (l *Leases) Release(ctx context.Context) error {
	l.mu.Lock()
	held := copyLeases(l.held)
	l.held = nil
	l.mu.Unlock()
	tx, err := l.DB.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = common.Rollback(tx) }()
	for shard, token := range held {
		if _, err := tx.Exec(ctx, `UPDATE saga_shard_leases SET expires_at=clock_timestamp()
			WHERE shard=$1 AND holder=$2 AND fencing_token=$3`, shard, l.Holder, token); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Check proves, inside the caller's tenant transaction, that this worker still
// holds the tenant's shard with the same token. FOR SHARE blocks a takeover
// until the side effect commits or rolls back.
func (l *Leases) Check(ctx context.Context, tx pgx.Tx, tenantID string) error {
	shard := ShardFor(tenantID)
	token, ok := l.Held()[shard]
	if !ok {
		return ErrLeaseLost
	}
	var one int
	err := tx.QueryRow(ctx, `SELECT 1 FROM saga_shard_leases WHERE shard=$1 AND holder=$2
		AND fencing_token=$3 AND expires_at > clock_timestamp() FOR SHARE`, shard, l.Holder, token).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrLeaseLost
	}
	if err != nil {
		return fmt.Errorf("check lease: %w", err)
	}
	return nil
}

// TenantsWithWork returns at most limit tenant IDs in one shard after the
// cursor, using the ID-only SECURITY DEFINER selector.
func TenantsWithWork(ctx context.Context, db common.TxStarter, shard int, after string, limit int) ([]string, error) {
	if shard < 0 || shard >= ShardCount || limit < 1 || limit > 500 ||
		(after != "" && !common.TenantPattern.MatchString(after)) {
		return nil, ErrInvalidRequest
	}
	tx, err := db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = common.Rollback(tx) }()
	var cursor any
	if after != "" {
		cursor = after
	}
	rows, err := tx.Query(ctx, `SELECT tenant_id::text FROM saga_shard_tenants($1::smallint, $2::uuid, $3)`,
		shard, cursor, limit)
	if err != nil {
		return nil, fmt.Errorf("list shard tenants: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	return ids, tx.Commit(ctx)
}

func (s Store) fence(ctx context.Context, tx pgx.Tx, tenantID string) error {
	if s.Fence == nil {
		return nil
	}
	return s.Fence.Check(ctx, tx, tenantID)
}
