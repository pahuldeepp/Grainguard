package history

import (
	"context"
	"errors"
	"testing"
	"time"
)

type identityRows struct {
	values [][]string
	index  int
	close  error
}

func (r *identityRows) Scan(dest ...any) bool {
	if r.index == len(r.values) {
		return false
	}
	*(dest[0].(*string)) = r.values[r.index][0]
	*(dest[1].(*string)) = r.values[r.index][1]
	*(dest[2].(*string)) = r.values[r.index][2]
	r.index++
	return true
}
func (r *identityRows) Close() error { return r.close }

type identitySession struct {
	captureSession
	rows Rows
}

func (s *identitySession) Iter(_ context.Context, _ Consistency, stmt string, args ...any) Rows {
	s.stmt, s.args = stmt, args
	return s.rows
}

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

func TestDayIdentitiesAreTenantDeviceAndDayScoped(t *testing.T) {
	rows := &identityRows{values: [][]string{{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "[]"}}}
	session := &identitySession{rows: rows}
	store := Store{Session: session}
	bucket := time.Date(2026, 10, 3, 19, 30, 0, 0, time.FixedZone("offset", -6*60*60))
	got, err := store.DayIdentities(context.Background(), "11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333", bucket)
	if err != nil || len(got) != 1 || got[0].ReadingID != rows.values[0][0] || got[0].EventID != rows.values[0][1] {
		t.Fatalf("identities=%+v err=%v", got, err)
	}
	if session.stmt != selectDayIdentities || session.args[0] != "11111111-1111-4111-8111-111111111111" || session.args[1] != "33333333-3333-4333-8333-333333333333" || session.args[2] != Day(bucket) {
		t.Fatalf("CQL query scope: %q %#v", session.stmt, session.args)
	}
}

func TestDayIdentitiesFailClosed(t *testing.T) {
	session := &identitySession{rows: &identityRows{close: errors.New("Cassandra unavailable")}}
	store := Store{Session: session}
	if _, err := store.DayIdentities(context.Background(), "not-a-tenant", "33333333-3333-4333-8333-333333333333", time.Now()); !errors.Is(err, ErrInvalidTenant) {
		t.Fatalf("invalid tenant err=%v", err)
	}
	if _, err := store.DayIdentities(context.Background(), "11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333", time.Now()); err == nil {
		t.Fatal("Cassandra read failure must stop coverage verification")
	}
}
