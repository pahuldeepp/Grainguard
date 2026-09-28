package common

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const tenantID = "3f2b8c1e-9a4d-4e7b-8c55-1d2e3f4a5b6c"

func TestAuthorityPlacementAuthenticationExpiryAndQuiesce(t *testing.T) {
	var calls atomic.Int32
	var state atomic.Value
	state.Store("active")
	var outage atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer private-test-token" || r.URL.Path != "/v1/internal/placements/"+tenantID {
			t.Error("unauthenticated or tenant-hinted request")
		}
		if outage.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tenantId": tenantID, "shardId": "s2", "shardIncarnation": tenantID, "placementEpoch": "9007199254740993", "state": state.Load(), "expiresAt": time.Now().Add(150 * time.Millisecond).UTC().Format(time.RFC3339Nano)})
	}))
	defer server.Close()
	r, err := NewHTTPPlacementResolver(server.URL, "private-test-token", false)
	if err != nil {
		t.Fatal(err)
	}
	first, err := r.Resolve(context.Background(), tenantID)
	if err != nil || first.PlacementEpoch != "9007199254740993" {
		t.Fatal(first, err)
	}
	if _, err := r.Resolve(context.Background(), tenantID); err != nil || calls.Load() != 1 {
		t.Fatal("route was not cached", err)
	}
	outage.Store(true)
	// Expiry is an actual authority deadline, not a stale-if-error policy.
	time.Sleep(175 * time.Millisecond)
	if _, err := r.Resolve(context.Background(), tenantID); !errors.Is(err, ErrPlacementUnavailable) {
		t.Fatal("expired route served during outage", err)
	}
	outage.Store(false)
	state.Store("quiescing")
	if _, err := r.Resolve(context.Background(), tenantID); !errors.Is(err, ErrTenantQuiescing) {
		t.Fatal("quiescing tenant admitted", err)
	}
	for _, base := range []string{"http://control.example", "https://user:pass@control.example", "file:///tmp/control"} {
		if _, err := NewHTTPPlacementResolver(base, "private", false); err == nil {
			t.Fatal("unsafe authority client accepted", base)
		}
	}
	if _, err := NewHTTPPlacementResolver("http://control.internal", "private", true); err != nil {
		t.Fatal("explicit mesh mTLS unavailable", err)
	}
}

func testShardRegistry() ShardRegistry {
	s := ShardRegistry{FormatVersion: 1, Service: "test", Database: "greenguard_test", Shards: map[string]ShardEndpoint{}}
	for index, id := range []string{"s1", "s2", "s3", "s4"} {
		s.Shards[id] = ShardEndpoint{Incarnation: tenantID, PrimaryURL: fmt.Sprintf("postgres://test_app:private@127.0.0.1:%d/greenguard_test?sslmode=disable", 5400+index), ReplicaURLs: []string{}}
	}
	return s
}

func TestPrivateShardRegistryAndPoolShutdown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shards.json")
	body, _ := json.Marshal(testShardRegistry())
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	registry, err := LoadShardRegistry(path, "test", "greenguard_test", "test_app")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := LoadShardRegistry(path, "other", "greenguard_test", "test_app"); err == nil {
		t.Fatal("wrong service accepted")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadShardRegistry(path, "test", "greenguard_test", "test_app"); err == nil {
		t.Fatal("public credentials file accepted")
	}
	s := NewShardedDB(registry, fixedPlacement{TenantPlacement{TenantID: tenantID, ShardID: "s2", Incarnation: tenantID, PlacementEpoch: "1", State: "active", ExpiresAt: time.Now().Add(time.Second)}, nil})
	pool, err := s.Primary(context.Background(), "s2")
	if err != nil || pool.Config().MaxConns != 5 {
		t.Fatal("pool budget unavailable", err)
	}
	same, err := s.Primary(context.Background(), "s2")
	if err != nil || same != pool {
		t.Fatal("pool was not reused", err)
	}
	if _, err := s.BeginTx(context.Background(), pgx.TxOptions{}); !errors.Is(err, ErrUnscopedShardTransaction) {
		t.Fatal("unscoped shard accepted", err)
	}
	s.Close()
	s.Close()
	if _, err := s.Primary(context.Background(), "s2"); !errors.Is(err, ErrPlacementUnavailable) {
		t.Fatal("closed router admitted pool", err)
	}
}

type fixedPlacement struct {
	route TenantPlacement
	err   error
}

func (r fixedPlacement) Resolve(context.Context, string) (TenantPlacement, error) {
	return r.route, r.err
}

func TestShardAdmissionRejectsMismatchStaleAndOutageBeforeSQL(t *testing.T) {
	base := TenantPlacement{TenantID: tenantID, ShardID: "s2", Incarnation: tenantID, PlacementEpoch: "1", State: "active", ExpiresAt: time.Now().Add(time.Second)}
	for _, kind := range []string{"wrong tenant", "wrong incarnation", "expired", "outage", "quiescing"} {
		t.Run(kind, func(t *testing.T) {
			route := base
			var resolverErr error
			switch kind {
			case "wrong tenant":
				route.TenantID = "11111111-1111-4111-8111-111111111111"
			case "wrong incarnation":
				route.Incarnation = "11111111-1111-4111-8111-111111111111"
			case "expired":
				route.ExpiresAt = time.Now().Add(-time.Second)
			case "outage":
				resolverErr = ErrPlacementUnavailable
			case "quiescing":
				route.State = "quiescing"
			}
			s := NewShardedDB(testShardRegistry(), fixedPlacement{route, resolverErr})
			defer s.Close()
			called := false
			err := s.WithTenantSchema(context.Background(), tenantID, "public", func(context.Context, pgx.Tx) error { called = true; return nil })
			if err == nil || called {
				t.Fatal("invalid route reached business SQL", err)
			}
		})
	}
}

func TestPrivateRegistryRejectsURLOverridesAndDuplicatePhysicalAddresses(t *testing.T) {
	for _, bad := range []string{
		"postgres://test_app:private@127.0.0.1:5400/greenguard_test?sslmode=verify-full&sslmode=disable",
		"postgres://test_app:private@127.0.0.1:5400/greenguard_test?host=other&sslmode=disable",
		"postgres://test_app:private@127.0.0.1:5400/greenguard_test?user=test_app&sslmode=disable",
		"postgres://test_app:private@127.0.0.1:5400/greenguard_test?dbname=other&sslmode=disable",
		"postgres://test_app:private@127.0.0.1:5400/greenguard_test?options=-c%20search_path%3Devil&sslmode=disable",
		"postgres://test_app:private@127.0.0.1:5400/greenguard_test?service=hidden&sslmode=disable",
		"postgres://test_app:private@127.0.0.1:5401/greenguard_test?sslmode=disable",
		"postgres://test_app:different@127.0.0.1:5401/greenguard_test?sslmode=disable",
	} {
		t.Run(bad, func(t *testing.T) {
			registry := testShardRegistry()
			endpoint := registry.Shards["s1"]
			endpoint.PrimaryURL = bad
			registry.Shards["s1"] = endpoint
			path := filepath.Join(t.TempDir(), "shards.json")
			body, _ := json.Marshal(registry)
			if err := os.WriteFile(path, body, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadShardRegistry(path, "test", "greenguard_test", "test_app"); !errors.Is(err, ErrShardRegistry) {
				t.Fatal("ambiguous private registry admitted", err)
			}
		})
	}
}

type delayedBeginPlacementDB struct{ tx *placementTestTx }

func (d delayedBeginPlacementDB) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) {
	time.Sleep(20 * time.Millisecond)
	return d.tx, nil
}
func TestRouteExpiryDuringPoolAcquisitionRollsBackBeforeAdmission(t *testing.T) {
	tx := &placementTestTx{}
	route := TenantPlacement{TenantID: tenantID, ShardID: "s1", Incarnation: tenantID, PlacementEpoch: "1", State: "active", ExpiresAt: time.Now().Add(10 * time.Millisecond)}
	called := false
	err := WithTenantPlacement(context.Background(), delayedBeginPlacementDB{tx}, route, func(context.Context, pgx.Tx) error { called = true; return nil })
	if !errors.Is(err, ErrInvalidTenantPlacement) || called || len(tx.statements) != 0 || tx.rollbacks != 1 {
		t.Fatal("expired acquisition admitted SQL", err, tx)
	}
}

func TestDurableAdmissionFailureIsRepairableAndCannotBecomePoison(t *testing.T) {
	tx := &placementTestTx{execErr: &pgconn.PgError{Code: "42501", Message: "ownership mismatch"}}
	db := &placementTestDB{tx: tx}
	route := TenantPlacement{TenantID: tenantID, ShardID: "s1", Incarnation: tenantID, PlacementEpoch: "1", State: "active", ExpiresAt: time.Now().Add(time.Second)}
	err := WithTenantPlacement(context.Background(), db, route, func(context.Context, pgx.Tx) error { t.Fatal("rejected admission called mutation"); return nil })
	if !errors.Is(err, ErrTenantAdmissionRejected) || !IsPlacementPaused(err) || tx.rollbacks != 1 {
		t.Fatal(err, tx)
	}
}

func TestCacheCapacityPreservesUnexpiredIdentityFloors(t *testing.T) {
	prior := "11111111-1111-4111-8111-111111111111"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenant := strings.TrimPrefix(r.URL.Path, "/v1/internal/placements/")
		_ = json.NewEncoder(w).Encode(map[string]any{"tenantId": tenant, "shardId": "s1", "shardIncarnation": tenantID, "placementEpoch": "6", "state": "active", "expiresAt": time.Now().Add(time.Second).UTC().Format(time.RFC3339Nano)})
	}))
	defer server.Close()
	resolver, err := NewHTTPPlacementResolver(server.URL, "test-token", false)
	if err != nil {
		t.Fatal(err)
	}
	expiry := time.Now().Add(time.Second)
	for n := 0; n < 4095; n++ {
		id := fmt.Sprintf("55000000-%04x-4000-8000-000000000000", n)
		resolver.entries[id] = placementEntry{route: TenantPlacement{ExpiresAt: expiry}}
	}
	resolver.entries[prior] = placementEntry{route: TenantPlacement{TenantID: prior, ShardID: "s1", Incarnation: tenantID, PlacementEpoch: "7", State: "active", ExpiresAt: expiry}, until: time.Now().Add(-time.Second)}
	if _, err := resolver.Resolve(context.Background(), tenantID); err != nil {
		t.Fatal(err)
	}
	if len(resolver.entries) != 4096 {
		t.Fatal("capacity evicted valid identity floors", len(resolver.entries))
	}
	if _, err := resolver.Resolve(context.Background(), prior); !errors.Is(err, ErrPlacementUnavailable) {
		t.Fatal("regressed authority epoch admitted after capacity miss", err)
	}
}
