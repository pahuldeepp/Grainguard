package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
	"greenguard.local/projection-builder/migrations"
)

// This test owns matching scratch databases on four independent PostgreSQL
// clusters. It exercises runtime roles, actual placement admission and effects.
func TestDatabaseShardedProjectionRouting(t *testing.T) {
	raw := envOrSkip(t, "TASK5_SHARD_ADMIN_URLS")
	urls := strings.Split(raw, ",")
	if len(urls) != 4 {
		t.Fatal("four scratch primary clusters required")
	}
	ctx := context.Background()
	name := fmt.Sprintf("projection_sharded_test_%d", time.Now().UnixNano())
	registry := common.ShardRegistry{FormatVersion: 1, Service: "projection-builder", Database: name, Shards: map[string]common.ShardEndpoint{}}
	admins := make([]*pgx.Conn, 4)
	incarnations := make([]string, 4)
	for i, raw := range urls {
		cluster, err := pgx.Connect(ctx, raw)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := cluster.Exec(ctx, "CREATE DATABASE "+name+" OWNER projection_migrator"); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = cluster.Exec(context.Background(), "DROP DATABASE "+name+" WITH (FORCE)")
			_ = cluster.Close(context.Background())
		})
		ownerURL := databaseURL(t, raw, name)
		u, _ := url.Parse(ownerURL)
		u.User = url.UserPassword("projection_migrator", "task5-local-only")
		if err := migrations.Up(u.String()); err != nil {
			t.Fatal(err)
		}
		admin, err := pgx.Connect(ctx, ownerURL)
		if err != nil {
			t.Fatal(err)
		}
		admins[i] = admin
		t.Cleanup(func() { _ = admin.Close(context.Background()) })
		incarnations[i] = randomUUID()
		shard := fmt.Sprintf("s%d", i+1)
		if _, err := admin.Exec(ctx, "SELECT greenguard_internal.seed_projection_infrastructure_ownership($1,$2,1)", shard, incarnations[i]); err != nil {
			t.Fatal(err)
		}
		u.User = url.UserPassword("projection_app", "task5-local-only")
		registry.Shards[shard] = common.ShardEndpoint{Incarnation: incarnations[i], PrimaryURL: u.String(), ReplicaURLs: []string{}}
	}
	path := filepath.Join(t.TempDir(), "shards.json")
	body, _ := json.Marshal(registry)
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	registry, err := common.LoadShardRegistry(path, "projection-builder", name, "projection_app")
	if err != nil {
		t.Fatal(err)
	}
	tenants := []string{randomUUID(), randomUUID(), randomUUID(), randomUUID()}
	routes := map[string]common.TenantPlacement{}
	var mu sync.Mutex
	for i, tenant := range tenants {
		shard := fmt.Sprintf("s%d", i+1)
		if _, err := admins[i].Exec(ctx, `INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,$2,$3,9007199254740993,'active')`, tenant, shard, incarnations[i]); err != nil {
			t.Fatal(err)
		}
		routes[tenant] = common.TenantPlacement{TenantID: tenant, ShardID: shard, Incarnation: incarnations[i], PlacementEpoch: "9007199254740993", State: "active"}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer task5-private-test" {
			w.WriteHeader(401)
			return
		}
		tenant := strings.TrimPrefix(r.URL.Path, "/v1/internal/placements/")
		mu.Lock()
		route, ok := routes[tenant]
		mu.Unlock()
		if !ok {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tenantId": route.TenantID, "shardId": route.ShardID, "shardIncarnation": route.Incarnation, "placementEpoch": route.PlacementEpoch, "state": route.State, "expiresAt": time.Now().Add(time.Second).UTC().Format(time.RFC3339Nano)})
	}))
	defer server.Close()
	resolver, err := common.NewHTTPPlacementResolver(server.URL, "task5-private-test", false)
	if err != nil {
		t.Fatal(err)
	}
	db := common.NewShardedDB(registry, resolver)
	defer db.Close()
	store := &Store{DB: db}
	aggregate := randomUUID()
	for i, tenant := range tenants {
		event := dbEvent(t, tenant, aggregate, 1)
		if err := store.Apply(ctx, message(event), event); err != nil {
			t.Fatal(i, err)
		}
		if err := store.Apply(ctx, message(event), event); !errors.Is(err, ErrDuplicate) {
			t.Fatal("unstable routed duplicate", err)
		}
		for j, admin := range admins {
			expected := 0
			if i == j {
				expected = 1
			}
			if count := scalar(t, admin, "SELECT count(*) FROM consumer_inbox WHERE tenant_id=$1", tenant); count != expected {
				t.Fatal("event reached wrong primary", i, j, count)
			}
		}
		if n := scalar(t, admins[i], "SELECT sequence FROM projection_watermarks WHERE tenant_id=$1", tenant); n != 1 {
			t.Fatal("routed duplicate advanced sequence", n)
		}
	}
	// The authority's route cannot bypass a contradictory durable local owner.
	tenant := tenants[0]
	mu.Lock()
	wrong := routes[tenant]
	wrong.ShardID = "s2"
	wrong.Incarnation = incarnations[1]
	routes[tenant] = wrong
	mu.Unlock()
	resolver.Invalidate(tenant)
	event := dbEvent(t, tenant, aggregate, 2)
	if err := store.Apply(ctx, message(event), event); !postgresCode(err, "42501") {
		t.Fatal("wrong primary admitted", err)
	}
	mu.Lock()
	wrong.State = "quiescing"
	routes[tenant] = wrong
	mu.Unlock()
	resolver.Invalidate(tenant)
	if err := store.Apply(ctx, message(event), event); !errors.Is(err, common.ErrTenantQuiescing) {
		t.Fatal("quiescing accepted", err)
	}
	if n := scalar(t, admins[0], "SELECT count(*) FROM consumer_inbox WHERE tenant_id=$1", tenant); n != 1 {
		t.Fatal("paused event changed prior owner", n)
	}
	// Source barriers are infrastructure metadata copied explicitly to all shards.
	cp := checkpointMessage()
	if err := store.Heartbeat(ctx, cp); err != nil {
		t.Fatal(err)
	}
	for _, admin := range admins {
		if n := scalar(t, admin, "SELECT count(*) FROM projection_checkpoints WHERE tenant_id=$1 AND source_time IS NOT NULL", common.InfrastructureTenant); n != 1 {
			t.Fatal("barrier missed shard", n)
		}
	}
	// Read-only infrastructure enumeration is compatible with standby transactions.
	tx, err := db.InfrastructureDB("s1").BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	var shard string
	if err := tx.QueryRow(ctx, "SELECT current_setting('app.shard_id')").Scan(&shard); err != nil || shard != "s1" {
		t.Fatal(shard, err)
	}
	_ = tx.Rollback(ctx)
	broken := registry
	broken.Shards = map[string]common.ShardEndpoint{}
	for id, endpoint := range registry.Shards {
		broken.Shards[id] = endpoint
	}
	endpoint := broken.Shards["s1"]
	endpoint.Incarnation = randomUUID()
	broken.Shards["s1"] = endpoint
	stale := common.NewShardedDB(broken, resolver)
	defer stale.Close()
	if err := stale.WithInfrastructure(ctx, "s1", "", func(context.Context, pgx.Tx) error { t.Fatal("mismatched infrastructure admitted"); return nil }); !postgresCode(err, "42501") {
		t.Fatal("infrastructure mismatch did not fail", err)
	}
}
