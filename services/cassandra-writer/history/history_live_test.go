package history

import (
	"context"
	"os"
	"testing"
	"time"
)

// The outage gate in another package restarts this single local node. A Docker
// health result can precede a usable driver pool, so wait for a real CQL read.
func liveSession(t *testing.T, cfg Config) *CQLSession {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		session, err := Open(cfg)
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err = session.Ping(ctx)
			cancel()
			if err == nil {
				return session
			}
			session.Close()
		}
		if time.Now().After(deadline) {
			t.Fatalf("Cassandra did not become CQL-ready within 30s: %v", err)
		}
		time.Sleep(time.Second)
	}
}

func TestLiveHistoryReplayAndTenantIsolation(t *testing.T) {
	if os.Getenv("CASSANDRA_LIVE") != "1" {
		t.Skip("set CASSANDRA_LIVE=1 after make cassandra-up")
	}
	cfg, err := LoadConfig(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	session := liveSession(t, cfg)
	defer session.Close()
	store := &Store{Session: session, TTL: 24 * time.Hour, MaxRows: 100, MaxDays: 3}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tenantA := "11111111-1111-4111-8111-111111111111"
	tenantB := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	device := "33333333-3333-4333-8333-333333333333"
	observed := time.Now().UTC().Truncate(time.Millisecond)
	r := Reading{TenantID: tenantA, DeviceID: device, ReadingID: "bb70cd06-0720-461a-8ecf-a56754985f87", EventID: "0d72ff07-a646-4d41-9b5b-52c5f25e4ca8", SiteID: "22222222-2222-4222-8222-222222222222", BinID: "55555555-5555-4555-8555-555555555555", ObservedAt: observed, ReceivedAt: observed, StreamVersion: 42}
	for i := 0; i < 2; i++ {
		if err := store.Write(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		tenant string
		want   int
	}{{tenantA, 1}, {tenantB, 0}} {
		result, err := store.Query(ctx, tc.tenant, device, observed.Add(-time.Second), observed.Add(time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Readings) != tc.want {
			t.Fatalf("tenant %s: got %d readings, want %d", tc.tenant, len(result.Readings), tc.want)
		}
	}
	if err := store.Confirm(ctx, Watermark{TenantID: tenantA, DeviceID: device, Topic: "greenguard.telemetry.recorded.v1", Partition: 0, Offset: 42, ObservedAt: observed}); err != nil {
		t.Fatal(err)
	}
	mark, found, err := store.ReadWatermark(ctx, tenantA, device, "greenguard.telemetry.recorded.v1", 0)
	if err != nil || !found || mark.Offset != 42 {
		t.Fatalf("watermark: %+v, found=%v, err=%v", mark, found, err)
	}
	_, found, err = store.ReadWatermark(ctx, tenantB, device, "greenguard.telemetry.recorded.v1", 0)
	if err != nil || found {
		t.Fatalf("cross-tenant watermark visible: found=%v, err=%v", found, err)
	}
}

func TestLiveHistoryAcceptsUnboundBin(t *testing.T) {
	if os.Getenv("CASSANDRA_LIVE") != "1" {
		t.Skip("set CASSANDRA_LIVE=1 after make cassandra-up")
	}
	cfg, err := LoadConfig(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	session := liveSession(t, cfg)
	defer session.Close()
	store := &Store{Session: session, TTL: time.Hour, MaxRows: 10, MaxDays: 2}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	observed := time.Now().UTC().Truncate(time.Millisecond)
	r := Reading{TenantID: "688d3317-6850-4637-9ca9-57cb37225908", DeviceID: "8fb09d32-1dcb-4d85-90ea-17799f272d6b", ReadingID: "760b6875-7978-4e2d-b571-96aac85a3905", EventID: "d5f9da28-a105-4938-8039-0e2ca5ac9712", SiteID: "4edc347a-2d29-4766-b9dc-c3f799c142ae", ObservedAt: observed, ReceivedAt: observed, StreamVersion: 1}
	if err := store.Write(ctx, r); err != nil {
		t.Fatal(err)
	}
	result, err := store.Query(ctx, r.TenantID, r.DeviceID, observed.Add(-time.Second), observed.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Readings) != 1 || result.Readings[0].BinID != "" {
		t.Fatalf("unbound bin query: %+v", result.Readings)
	}
}

func TestLiveHistoryShortTTLExpires(t *testing.T) {
	if os.Getenv("CASSANDRA_LIVE") != "1" {
		t.Skip("set CASSANDRA_LIVE=1 after make cassandra-up")
	}
	cfg, err := LoadConfig(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	session := liveSession(t, cfg)
	defer session.Close()
	store := &Store{Session: session, TTL: 3 * time.Second, MaxRows: 10, MaxDays: 2}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	observed := time.Now().UTC().Truncate(time.Millisecond)
	r := Reading{TenantID: "4fe74b86-0b4a-43ad-ab35-a3905074532c", DeviceID: "ea7350d8-9595-47a0-a794-73509b53d8be", ReadingID: "c65ef992-edf8-4cc9-bd13-79680bcf58bf", EventID: "7dffbf77-d07c-4fb7-8b92-c898b1d14fda", SiteID: "6e7d0538-4b5c-47b0-94cd-d18eb9811c73", BinID: "bbcdf414-fc94-487a-86d2-43fe5810d4d8", ObservedAt: observed, ReceivedAt: observed, StreamVersion: 1}
	if err := store.Write(ctx, r); err != nil {
		t.Fatal(err)
	}
	query := func() int {
		result, err := store.Query(ctx, r.TenantID, r.DeviceID, observed.Add(-time.Second), observed.Add(time.Second))
		if err != nil {
			t.Fatal(err)
		}
		return len(result.Readings)
	}
	if got := query(); got != 1 {
		t.Fatalf("immediate read: got %d rows, want 1", got)
	}
	for ctx.Err() == nil {
		if got := query(); got == 0 {
			return
		}
		select {
		case <-ctx.Done():
		case <-time.After(250 * time.Millisecond):
		}
	}
	t.Fatal("short-TTL row remained visible after 25 seconds")
}
