package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

func TestControlPlaneURLPolicy(t *testing.T) {
	for _, tc := range []struct {
		name, raw, mesh string
		valid           bool
	}{
		{"https", "https://control.example", "", true},
		{"localhost", "http://localhost:8080", "", true},
		{"loopback", "http://127.0.0.1:8080", "", true},
		{"mesh service", "http://tenant-control-plane.greenguard.svc.cluster.local", "true", true},
		{"mesh without attestation", "http://tenant-control-plane.greenguard.svc.cluster.local", "", false},
		{"external HTTP", "http://control.example", "true", false},
		{"userinfo", "https://user:secret@control.example", "", false},
		{"query", "https://control.example?q=1", "", false},
		{"fragment", "https://control.example#fragment", "", false},
		{"missing host", "https:///path", "", false},
		{"malformed", "%", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := map[string]string{"CONTROL_PLANE_URL": tc.raw, "CONTROL_PLANE_MESH_MTLS": tc.mesh}
			_, err := controlPlaneURL(func(key string) string { return env[key] })
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v error=%v", tc.valid, err)
			}
		})
	}
}

func TestAPIEnvironmentPreservesShardRequirementAndJWKSValidation(t *testing.T) {
	for _, tc := range []struct {
		name, direct, registry, required, jwks string
		valid                                  bool
	}{
		{"local", "postgres://fixture", "", "", "http://127.0.0.1/keys", true},
		{"sharded", "", "registry.json", "true", "https://issuer.example/keys", true},
		{"required registry missing", "postgres://fixture", "", "true", "https://issuer.example/keys", false},
		{"direct URL missing", "", "", "", "https://issuer.example/keys", false},
		{"unsafe JWKS", "postgres://fixture", "", "", "http://issuer.example/keys", false},
		{"malformed JWKS", "postgres://fixture", "", "", "%", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := map[string]string{"SAGA_DIRECT_URL": tc.direct, "SHARD_REGISTRY_FILE": tc.registry, "SHARD_ROUTING_REQUIRED": tc.required, "AUTH_ISSUER": "issuer", "AUTH_AUDIENCE": "audience", "AUTH_JWKS_URL": tc.jwks}
			_, err := apiEnvironment(func(key string) string { return env[key] })
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v error=%v", tc.valid, err)
			}
		})
	}
}

func TestMembershipRefreshFailurePolicy(t *testing.T) {
	for _, tc := range []struct {
		name, floor, errText, wantRole string
		age                            time.Duration
		status                         int
		redisDown                      bool
	}{
		{"lookup outage uses bounded cache", "", "", "viewer", time.Minute, 503, false},
		{"lookup outage rejects expired cache", "", "membership lookup failed", "", 6 * time.Minute, 503, false},
		{"Redis outage rejects recent cache", "", "redis unavailable", "", time.Minute, 200, true},
		{"stale Redis lookup uses bounded cache", "2", "", "viewer", time.Minute, 200, false},
		{"stale Redis lookup rejects expired cache", "2", "stale membership lookup", "", 6 * time.Minute, 200, false},
		{"malformed Redis floor rejects expired cache", "bad", "stale membership lookup", "", 6 * time.Minute, 200, false},
		{"missing membership replaces recent cache", "", "identity has no active", "", time.Minute, 404, false},
		{"missing Redis floor allows refresh", "", "", "operator", 6 * time.Minute, 200, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lookup := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				if tc.status == 200 {
					_ = json.NewEncoder(w).Encode(controlMembership{TenantID: "tenant", Roles: []string{"operator"}, Version: "1", State: "active"})
				}
			}))
			defer lookup.Close()
			id := identityID("issuer", "subject")
			cached := &controlMembership{TenantID: "tenant", Roles: []string{"viewer"}, Version: "1", State: "active"}
			versions := &versionRedis{versions: map[string]string{membershipRedisKey(id, "tenant"): tc.floor}, down: tc.redisDown}
			cache := &controlMembershipCache{url: lookup.URL, client: lookup.Client(), redis: versions, entries: map[string]membershipEntry{id: {cached, time.Now().Add(-tc.age)}}, floors: map[string]map[string]uint64{}}
			tenant, roles, err := cache.roles(context.Background(), "issuer", "subject")
			assertMembershipRefreshResult(t, tc.errText, tc.wantRole, tenant, roles, err)
		})
	}
}

func assertMembershipRefreshResult(t *testing.T, errText, wantRole, tenant string, roles map[string]bool, err error) {
	t.Helper()
	if errText != "" {
		if err == nil || !strings.Contains(err.Error(), errText) || tenant != "" || roles != nil {
			t.Fatalf("expected denial %q; tenant=%s roles=%v error=%v", errText, tenant, roles, err)
		}
		return
	}
	if err != nil || tenant != "tenant" || len(roles) != 1 || !roles[wantRole] {
		t.Fatalf("expected membership; tenant=%s roles=%v error=%v", tenant, roles, err)
	}
}

func TestFreshMembershipChecksLocalEventFloorUnderLock(t *testing.T) {
	id := "identity"
	old := membershipEntry{value: &controlMembership{TenantID: "tenant", Version: "1"}, fetched: time.Now()}
	cache := &controlMembershipCache{entries: map[string]membershipEntry{id: old}, floors: map[string]map[string]uint64{id: {"tenant": 3}}}
	fresh := &controlMembership{TenantID: "tenant", Version: "2"}
	entry, ok, err := cache.cacheFreshMembership(id, fresh, 2, time.Now(), old, true, nil)
	if err == nil || err.Error() != "stale membership event" || !ok || entry.value != old.value || cache.entries[id].value != old.value {
		t.Fatalf("event floor allowed stale replacement: entry=%+v ok=%v error=%v", entry, ok, err)
	}
}

func TestMembershipConsumerCommitPolicy(t *testing.T) {
	valid := `{"event_type":"membership.changed","tenant_id":"tenant","payload":{"identity_id":"identity","membership_version":"2"}}`
	for _, tc := range []struct {
		name, value       string
		redisDown, commit bool
		advance           bool
	}{
		{"change applied before commit", valid, false, true, true},
		{"Redis failure holds offset", valid, true, false, false},
		{"malformed JSON discarded", "{", false, true, false},
		{"oversize discarded", strings.Repeat("x", (1<<20)+1), false, true, false},
		{"invalid version discarded", strings.Replace(valid, `"2"`, `"0"`, 1), false, true, false},
		{"missing identity discarded", strings.Replace(valid, `"identity"`, `""`, 1), false, true, false},
		{"missing tenant discarded", strings.Replace(valid, `"tenant"`, `""`, 1), false, true, false},
		{"unrelated event committed", `{"event_type":"other"}`, false, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			versions := &versionRedis{versions: map[string]string{}, down: tc.redisDown}
			cache := &controlMembershipCache{redis: versions, entries: map[string]membershipEntry{}, floors: map[string]map[string]uint64{}}
			record := &kgo.Record{Value: []byte(tc.value)}
			committed := false
			err := cache.consumeMembershipRecord(context.Background(), record, func(_ context.Context, records ...*kgo.Record) error {
				committed = true
				if len(records) != 1 || records[0] != record {
					t.Fatal("committed a different record")
				}
				if tc.advance && versions.versions[membershipRedisKey("identity", "tenant")] != "2" {
					t.Fatal("offset advanced before membership version floor")
				}
				return nil
			})
			if committed != tc.commit || (err == nil) != tc.commit {
				t.Fatalf("committed=%v expected=%v error=%v", committed, tc.commit, err)
			}
		})
	}
}

func TestMembershipRedisConfigurationParsing(t *testing.T) {
	options, err := membershipRedisClusterOptions([]string{" redis://node-a:6379 ", "redis://node-b:6380"})
	var addresses []string
	if options != nil {
		addresses = options.Addrs
	}
	if err != nil || len(addresses) != 2 || addresses[0] != "node-a:6379" || addresses[1] != "node-b:6380" {
		t.Fatalf("cluster addresses=%v error=%v", addresses, err)
	}
	for _, node := range []string{"%", "redis:///missing-host", ""} {
		if _, err := membershipRedisClusterOptions([]string{node}); err == nil {
			t.Fatalf("invalid cluster node accepted: %q", node)
		}
	}
	mapped, err := membershipRedisAddressMap(",node-a:6379=localhost:16379,node-a:6379=localhost:26379,")
	if err != nil || len(mapped) != 1 || mapped["node-a:6379"] != "localhost:26379" {
		t.Fatalf("address map=%v error=%v", mapped, err)
	}
	for _, pair := range []string{"missing-separator", "=target", "source="} {
		if _, err := membershipRedisAddressMap(pair); err == nil {
			t.Fatalf("invalid address map accepted: %q", pair)
		}
	}
}
