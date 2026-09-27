package history

import (
	"context"
	"errors"
	"testing"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

type fakeConn struct {
	err    error
	closed bool
	execs  int
}

func (f *fakeConn) Exec(context.Context, Consistency, string, ...any) error { f.execs++; return f.err }
func (f *fakeConn) Iter(context.Context, Consistency, string, ...any) Rows  { return failedRows{f.err} }
func (f *fakeConn) Ping(context.Context) error                              { return f.err }
func (f *fakeConn) Close()                                                  { f.closed = true }

type opener struct {
	conns []*fakeConn
	err   error
	calls int
}

func (o *opener) open() (Conn, error) {
	o.calls++
	if o.err != nil {
		return nil, o.err
	}
	c := &fakeConn{}
	o.conns = append(o.conns, c)
	return c, nil
}

func TestReconnectingStartsWhileDownThenConnects(t *testing.T) {
	o := &opener{err: errors.New("connection refused")}
	r := &Reconnecting{Open: o.open}
	ctx := context.Background()
	if err := r.Connect(); !errors.Is(err, ErrNotConnected) || !Transient(err) {
		t.Fatalf("connect while down = %v, want transient ErrNotConnected", err)
	}
	if err := r.Exec(ctx, LocalQuorum, "q"); !Transient(err) {
		t.Fatalf("exec while down = %v", err)
	}
	if err := r.Iter(ctx, LocalQuorum, "q").Close(); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("iter while down = %v", err)
	}
	if r.Iter(ctx, LocalQuorum, "q").Scan() {
		t.Fatal("failed rows scanned")
	}
	if err := r.Ping(ctx); !errors.Is(err, ErrNotConnected) || o.calls != 4 {
		t.Fatalf("ping must not dial: err=%v calls=%d", err, o.calls)
	}
	o.err = nil
	if err := r.Connect(); err != nil || !r.Connected() || r.Reconnects.Load() != 1 {
		t.Fatalf("connect after recovery: %v", err)
	}
	if err := r.Connect(); err != nil || o.calls != 5 {
		t.Fatalf("second connect re-dialled: calls=%d", o.calls)
	}
	if err := r.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	if err := r.Iter(ctx, LocalQuorum, "q").Close(); err != nil {
		t.Fatal(err)
	}
}

func TestReconnectingDropsSessionTheDriverMarkedDown(t *testing.T) {
	o := &opener{}
	r := &Reconnecting{Open: o.open}
	ctx := context.Background()
	if err := r.Connect(); err != nil {
		t.Fatal(err)
	}
	first := o.conns[0]
	first.err = gocql.ErrNoConnections
	if err := r.Exec(ctx, LocalQuorum, "q"); !errors.Is(err, gocql.ErrNoConnections) {
		t.Fatal(err)
	}
	if !first.closed || r.Connected() {
		t.Fatal("no-hosts session was kept")
	}
	if err := r.Exec(ctx, LocalQuorum, "q"); err != nil || len(o.conns) != 2 || r.Reconnects.Load() != 2 {
		t.Fatalf("session not re-created: err=%v conns=%d", err, len(o.conns))
	}
}

func TestReconnectingDropsAfterConsecutiveTransientFailures(t *testing.T) {
	o := &opener{}
	r := &Reconnecting{Open: o.open}
	ctx := context.Background()
	_ = r.Connect()
	c := o.conns[0]
	c.err = gocql.ErrTimeoutNoResponse
	for i := 1; i < dropAfter; i++ {
		_ = r.Exec(ctx, LocalQuorum, "q")
	}
	if c.closed {
		t.Fatal("dropped before threshold")
	}
	c.err = nil
	_ = r.Exec(ctx, LocalQuorum, "q") // success resets the count
	c.err = gocql.ErrTimeoutNoResponse
	for i := 1; i < dropAfter; i++ {
		_ = r.Ping(ctx)
	}
	if c.closed {
		t.Fatal("success did not reset failure count")
	}
	_ = r.Ping(ctx)
	if !c.closed || r.Connected() {
		t.Fatal("session kept after consecutive transient failures")
	}
}

func TestReconnectingKeepsSessionOnPermanentErrorsAndStaleObservations(t *testing.T) {
	o := &opener{}
	r := &Reconnecting{Open: o.open}
	_ = r.Connect()
	c := o.conns[0]
	c.err = errors.New("invalid query")
	for i := 0; i < dropAfter+1; i++ {
		_ = r.Exec(context.Background(), LocalQuorum, "q")
	}
	if c.closed {
		t.Fatal("permanent error dropped the session")
	}
	r.observe(&fakeConn{}, gocql.ErrNoConnections) // result from a replaced session
	if !r.Connected() {
		t.Fatal("stale observation dropped the live session")
	}
	r.Close()
	if !c.closed || r.Connected() {
		t.Fatal("close did not release the session")
	}
	r.Close()
}

func TestTransientClassifiesReconnectErrors(t *testing.T) {
	for _, err := range []error{ErrNotConnected, gocql.ErrSessionClosed, gocql.ErrNoConnectionsStarted, gocql.ErrNoConnections} {
		if !Transient(err) {
			t.Fatalf("%v not transient", err)
		}
	}
	if Transient(errors.New("invalid query")) {
		t.Fatal("permanent error classified transient")
	}
}
