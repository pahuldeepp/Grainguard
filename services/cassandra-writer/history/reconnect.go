package history

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

// Conn is one live driver session.
type Conn interface {
	Session
	Ping(context.Context) error
	Close()
}

// ErrNotConnected means no session exists yet; it is transient.
var ErrNotConnected = errors.New("cassandra session not connected")

// dropAfter is how many consecutive transient failures discard a session.
// gocql re-dials DOWN hosts only every ReconnectInterval (60s by default), so
// a fresh session recovers a restarted single node much sooner.
const dropAfter = 3

// Reconnecting owns a replaceable session. It never fails permanently because
// Cassandra is unavailable: a missing or discarded session is re-created on
// the next Connect or statement. Statements stay idempotent upserts.
type Reconnecting struct {
	Open       func() (Conn, error)
	mu         sync.Mutex
	conn       Conn
	failures   int
	Reconnects atomic.Uint64
}

// Connect opens a session when none exists. It is safe to call repeatedly.
func (r *Reconnecting) Connect() error {
	_, err := r.current(true)
	return err
}

// Connected reports whether a session is currently held.
func (r *Reconnecting) Connected() bool {
	c, _ := r.current(false)
	return c != nil
}

func (r *Reconnecting) current(open bool) (Conn, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conn != nil || !open {
		return r.conn, nil
	}
	c, err := r.Open()
	if err != nil {
		return nil, errors.Join(ErrNotConnected, err)
	}
	r.conn, r.failures = c, 0
	r.Reconnects.Add(1)
	return c, nil
}

// observe records one statement result and discards a session the driver can
// no longer route through.
func (r *Reconnecting) observe(c Conn, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conn != c {
		return
	}
	if err == nil || !Transient(err) {
		r.failures = 0
		return
	}
	r.failures++
	if errors.Is(err, gocql.ErrNoConnections) || r.failures >= dropAfter {
		r.conn = nil
		c.Close()
	}
}

func (r *Reconnecting) Exec(ctx context.Context, level Consistency, stmt string, args ...any) error {
	c, err := r.current(true)
	if err != nil {
		return err
	}
	err = c.Exec(ctx, level, stmt, args...)
	r.observe(c, err)
	return err
}

// Iter needs a live session; without one it returns rows that report the
// connection error on Close.
func (r *Reconnecting) Iter(ctx context.Context, level Consistency, stmt string, args ...any) Rows {
	c, err := r.current(true)
	if err != nil {
		return failedRows{err}
	}
	return c.Iter(ctx, level, stmt, args...)
}

// Ping never dials, so a readiness probe cannot block on session creation.
func (r *Reconnecting) Ping(ctx context.Context) error {
	c, _ := r.current(false)
	if c == nil {
		return ErrNotConnected
	}
	err := c.Ping(ctx)
	r.observe(c, err)
	return err
}

func (r *Reconnecting) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conn != nil {
		r.conn.Close()
		r.conn = nil
	}
}

type failedRows struct{ err error }

func (failedRows) Scan(...any) bool { return false }
func (f failedRows) Close() error   { return f.err }
