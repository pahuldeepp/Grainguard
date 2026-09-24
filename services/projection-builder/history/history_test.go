package history

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestConfigurationBounds(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  time.Duration
		bad   bool
	}{
		{"", DefaultWindow, false}, {"1h", time.Hour, false}, {"2160h", 90 * 24 * time.Hour, false},
		{"59m", 0, true}, {"2161h", 0, true}, {"garbage", 0, true},
	} {
		got, err := Window(func(string) string { return tc.value })
		if got != tc.want || (err != nil) != tc.bad {
			t.Fatal(tc, got, err)
		}
	}
	for _, tc := range []struct {
		value string
		want  int
		bad   bool
	}{
		{"", 3, false}, {"1", 1, false}, {"30", 30, false}, {"0", 0, true}, {"31", 0, true}, {"bad", 0, true},
	} {
		got, err := Ahead(func(string) string { return tc.value })
		if got != tc.want || (err != nil) != tc.bad {
			t.Fatal(tc, got, err)
		}
	}
}

var errInjected = errors.New("maintenance failure")

type transaction struct {
	pgx.Tx
	step, fail, commits, rollbacks int
	t                              *testing.T
}

func (tx *transaction) Exec(ctx context.Context, q string, args ...any) (pgconn.CommandTag, error) {
	tx.step++
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 30*time.Second {
		tx.t.Fatal("unbounded pass")
	}
	if tx.step == 3 && (q != "SELECT public.projection_history_maintain($1::double precision,$2::integer)" || args[0] != DefaultWindow.Seconds() || args[1] != 3) {
		tx.t.Fatal(q, args)
	}
	if tx.step == tx.fail {
		return pgconn.CommandTag{}, errInjected
	}
	return pgconn.NewCommandTag("SELECT 1"), nil
}
func (tx *transaction) Commit(context.Context) error {
	tx.commits++
	if tx.fail == 4 {
		return errInjected
	}
	return nil
}
func (tx *transaction) Rollback(context.Context) error { tx.rollbacks++; return nil }

type starter struct {
	tx  *transaction
	err error
}

func (s starter) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) { return s.tx, s.err }
func TestMaintenanceFailureBoundaries(t *testing.T) {
	for fail := 0; fail <= 4; fail++ {
		tx := &transaction{fail: fail, t: t}
		err := Maintain(context.Background(), starter{tx: tx}, DefaultWindow, 3)
		if (err != nil) != (fail != 0) || tx.rollbacks != 1 {
			t.Fatal(fail, err, tx)
		}
		if fail > 0 && fail < 4 && tx.commits != 0 {
			t.Fatal("partial commit")
		}
	}
	if err := Maintain(context.Background(), starter{err: errInjected}, DefaultWindow, 3); !errors.Is(err, errInjected) {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		window time.Duration
		ahead  int
	}{{0, 3}, {91 * 24 * time.Hour, 3}, {DefaultWindow, 0}, {DefaultWindow, 31}} {
		if err := Maintain(context.Background(), nil, tc.window, tc.ahead); err == nil {
			t.Fatal("invalid configuration")
		}
	}
}
