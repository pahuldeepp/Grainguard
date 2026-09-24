package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	rejectionSlots    = 20
	rejectionThrottle = 10 * time.Second
	// A full map is swept at most once per interval, so a flood of new devices cannot
	// turn every rejection into a full-map scan under the lock.
	rejectionSweepInterval = time.Second
	rejectionThrottleCap   = 10_000
)

// RejectionRecorder counts every refusal and keeps a small, bounded sample per device for
// diagnosis. It never fails the caller: a refusal is already being reported.
type RejectionRecorder struct {
	db      TxStarter
	counter RejectionCounter
	now     func() time.Time

	mu        sync.Mutex
	last      map[string]time.Time
	capacity  int
	lastSweep time.Time
}

func NewRejectionRecorder(db TxStarter, counter RejectionCounter, now func() time.Time) *RejectionRecorder {
	if now == nil {
		now = time.Now
	}
	return &RejectionRecorder{db: db, counter: counter, now: now, last: map[string]time.Time{}, capacity: rejectionThrottleCap}
}

// allow limits sample writes per device so a flood of bad requests cannot become a flood
// of database writes. Only expired entries may be evicted; a full active map drops new samples.
func (r *RejectionRecorder) allow(tenantID, deviceID string, now time.Time) bool {
	key := tenantID + "/" + deviceID
	r.mu.Lock()
	defer r.mu.Unlock()
	if last, ok := r.last[key]; ok && now.Sub(last) < rejectionThrottle {
		return false
	}
	if len(r.last) >= r.capacity {
		r.sweep(now)
		if len(r.last) >= r.capacity {
			return false
		}
	}
	r.last[key] = now
	return true
}

// sweep evicts expired entries, at most once per rejectionSweepInterval. Callers hold r.mu.
func (r *RejectionRecorder) sweep(now time.Time) {
	if !r.lastSweep.IsZero() && now.Sub(r.lastSweep) < rejectionSweepInterval {
		return
	}
	r.lastSweep = now
	for key, last := range r.last {
		if now.Sub(last) >= rejectionThrottle {
			delete(r.last, key)
		}
	}
}

func randomSlot() int16 {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return int16(binary.BigEndian.Uint64(b[:]) % rejectionSlots)
}

// Record counts the rejection and, when allowed, overwrites a random sample slot. Only a
// digest of the body is stored.
func (r *RejectionRecorder) Record(ctx context.Context, tenantID, deviceID string, rej *Rejection, body []byte) {
	r.counter.IncRejection(rej.Reason)
	// A device that is not bound yet is only counted: its id is caller-chosen, so sampling it
	// would let unknown ids grow the table.
	if rej.Reason == ReasonDeviceNotReady || !isUUID(tenantID) || !isUUID(deviceID) {
		return
	}
	now := r.now().UTC().Truncate(time.Microsecond)
	digest := sha256.Sum256(body)
	err := WithTenant(ctx, r.db, tenantID, func(ctx context.Context, tx pgx.Tx) error {
		var bound bool
		if err := tx.QueryRow(ctx,
			"SELECT EXISTS (SELECT 1 FROM device_bindings WHERE tenant_id = $1 AND device_id = $2)",
			tenantID, deviceID).Scan(&bound); err != nil {
			return err
		}
		if !bound || !r.allow(tenantID, deviceID, now) {
			return nil
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO ingest_rejection_samples (tenant_id, device_id, slot, reason, payload_sha256, rejected_at)
			 SELECT $1::uuid, $2::uuid, $3::smallint, $4::text, $5::text, $6::timestamptz
			  WHERE EXISTS (SELECT 1 FROM device_bindings WHERE tenant_id = $1::uuid AND device_id = $2::uuid)
			 ON CONFLICT (tenant_id, device_id, slot) DO UPDATE
			 SET reason = EXCLUDED.reason, payload_sha256 = EXCLUDED.payload_sha256, rejected_at = EXCLUDED.rejected_at`,
			tenantID, deviceID, randomSlot(), rej.Reason, hex.EncodeToString(digest[:]), now)
		return err
	})
	if err != nil {
		slog.Warn("could not record rejection sample", "reason", rej.Reason, "error", err)
	}
}
