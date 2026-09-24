package history

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

var maintenanceSchema = regexp.MustCompile(`^read_v[1-9][0-9]{0,8}$`)

type Starter interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

// Maintain is a single bounded pass, scheduled externally. Invoker must own the
// projection schema; runtime projection_app has no function execution privilege.
func Maintain(ctx context.Context, db Starter, window time.Duration, ahead int, schemas ...string) error {
	if window < time.Hour || window > 90*24*time.Hour || ahead < 1 || ahead > 30 {
		return errors.New("invalid history retention configuration")
	}
	if len(schemas) > 1 {
		return errors.New("one history schema required")
	}
	schema := "public"
	if len(schemas) == 1 {
		schema = schemas[0]
	}
	if schema != "public" && !maintenanceSchema.MatchString(schema) {
		return errors.New("invalid history schema")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	tx, err := db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, q := range []string{"SET LOCAL lock_timeout = '2s'", "SET LOCAL statement_timeout = '25s'"} {
		if _, err = tx.Exec(ctx, q); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, fmt.Sprintf("SELECT %s.projection_history_maintain($1::double precision,$2::integer)", schema), window.Seconds(), ahead); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
