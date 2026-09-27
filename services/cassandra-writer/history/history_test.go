package history

import (
	"context"
	"testing"
	"time"
)

type captureSession struct {
	stmt string
	args []any
}

func (s *captureSession) Exec(_ context.Context, _ Consistency, stmt string, args ...any) error {
	s.stmt = stmt
	s.args = args
	return nil
}
func (*captureSession) Iter(context.Context, Consistency, string, ...any) Rows { return nil }

func TestWriteOmitsUnboundBinColumn(t *testing.T) {
	session := &captureSession{}
	store := Store{Session: session, TTL: time.Hour}
	r := Reading{TenantID: "11111111-1111-4111-8111-111111111111", DeviceID: "33333333-3333-4333-8333-333333333333", ObservedAt: time.Now(), ReceivedAt: time.Now()}
	if err := store.Write(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if session.stmt != insertUnboundReading || len(session.args) != 12 {
		t.Fatalf("unbound bin statement=%q args=%d", session.stmt, len(session.args))
	}
	r.BinID = "55555555-5555-4555-8555-555555555555"
	if err := store.Write(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if session.stmt != insertReading || session.args[9] != r.BinID {
		t.Fatalf("bound bin CQL argument = %#v, want %q", session.args[9], r.BinID)
	}
}
