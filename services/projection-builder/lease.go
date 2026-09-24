package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const writerLeaseTTL = 30 * time.Second

var ErrWriterLease = errors.New("versioned writer lease unavailable or fenced")

// Two-key advisory locks avoid coupling unrelated projection versions. The
// validated decimal version is collision-free within the supported name range.
func replayLockKey(schema string) (int32, error) {
	if schema == "public" {
		return 0, nil
	}
	if !promotionIdentifier.MatchString(schema) {
		return 0, ErrInvalidProjectionSchema
	}
	n, err := strconv.ParseInt(strings.TrimPrefix(schema, "read_v"), 10, 32)
	return int32(n), err
}

type writerLease struct {
	db     TxStarter
	schema string
	holder string
	epoch  int64
}

func newLeaseToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}

// The replay advisory lock prevents a writer starting during a finite rebuild.
// An expired holder can be replaced only after its effect transaction releases
// the lease row lock. Epochs make a former holder permanently stale.
func acquireWriterLease(ctx context.Context, db TxStarter, schema string) (*writerLease, error) {
	if !promotionIdentifier.MatchString(schema) {
		return nil, ErrInvalidProjectionSchema
	}
	token, err := newLeaseToken()
	if err != nil {
		return nil, err
	}
	l := &writerLease{db: db, schema: schema, holder: token}
	lockKey, err := replayLockKey(schema)
	if err != nil {
		return nil, err
	}
	err = WithTenant(ctx, db, infrastructureTenant, func(ctx context.Context, tx pgx.Tx) error {
		var free bool
		if err := tx.QueryRow(ctx, "SELECT pg_try_advisory_xact_lock(7240512,$1::integer)", lockKey).Scan(&free); err != nil {
			return err
		}
		if !free {
			return ErrWriterLease
		}
		return tx.QueryRow(ctx, `INSERT INTO public.projection_writer_leases(tenant_id,schema_name,holder,epoch,expires_at)
 VALUES($1,$2,$3,1,clock_timestamp()+interval '30 seconds')
 ON CONFLICT(tenant_id,schema_name) DO UPDATE SET holder=EXCLUDED.holder,
 epoch=public.projection_writer_leases.epoch+1,expires_at=EXCLUDED.expires_at
 WHERE public.projection_writer_leases.expires_at<=clock_timestamp()
 RETURNING epoch`, infrastructureTenant, schema, token).Scan(&l.epoch)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWriterLease
	}
	if err != nil {
		return nil, err
	}
	return l, nil
}

func (l *writerLease) check(ctx context.Context, tx pgx.Tx) error {
	if l == nil {
		return nil
	}
	var tenant string
	if err := tx.QueryRow(ctx, "SELECT current_setting('app.tenant_id',true)").Scan(&tenant); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id',$1,true)", infrastructureTenant); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '2s'"); err != nil {
		return err
	}
	var valid bool
	err := tx.QueryRow(ctx, `SELECT holder=$3::uuid AND epoch=$4 AND expires_at>clock_timestamp()
 FROM public.projection_writer_leases WHERE tenant_id=$1 AND schema_name=$2 FOR UPDATE`, infrastructureTenant, l.schema, l.holder, l.epoch).Scan(&valid)
	if err != nil || !valid {
		return ErrWriterLease
	}
	_, err = tx.Exec(ctx, "SELECT set_config('app.tenant_id',$1,true)", tenant)
	return err
}

func (l *writerLease) renew(ctx context.Context) error {
	return WithTenant(ctx, l.db, infrastructureTenant, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '2s'"); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE public.projection_writer_leases SET expires_at=clock_timestamp()+interval '30 seconds'
 WHERE tenant_id=$1 AND schema_name=$2 AND holder=$3 AND epoch=$4 AND expires_at>clock_timestamp()`, infrastructureTenant, l.schema, l.holder, l.epoch)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return ErrWriterLease
		}
		return nil
	})
}

func (l *writerLease) current(ctx context.Context) error {
	return WithTenant(ctx, l.db, infrastructureTenant, l.check)
}
