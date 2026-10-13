package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
)

type versionRedis struct {
	redis.UniversalClient
	versions map[string]string
	down     bool
}

func (r *versionRedis) Get(_ context.Context, key string) *redis.StringCmd {
	if r.down {
		return redis.NewStringResult("", errors.New("redis unavailable"))
	}
	if value, ok := r.versions[key]; ok {
		return redis.NewStringResult(value, nil)
	}
	return redis.NewStringResult("", redis.Nil)
}
func (r *versionRedis) Eval(_ context.Context, _ string, keys []string, args ...interface{}) *redis.Cmd {
	if r.down {
		return redis.NewCmdResult(nil, errors.New("redis unavailable"))
	}
	next := args[0].(string)
	old := r.versions[keys[0]]
	if len(next) > len(old) || (len(next) == len(old) && next > old) {
		r.versions[keys[0]] = next
	}
	return redis.NewCmdResult(int64(1), nil)
}

func TestControlMembershipRevocationAndTenantIsolation(t *testing.T) {
	const tenantA = "11111111-1111-4111-8111-111111111111"
	const tenantB = "22222222-2222-4222-8222-222222222222"
	state := map[string]controlMembership{
		"alice": {TenantID: tenantA, Roles: []string{"operator"}, Version: "1", State: "active"},
		"bob":   {TenantID: tenantB, Roles: []string{"viewer"}, Version: "1", State: "active"},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			w.WriteHeader(401)
			return
		}
		m, ok := state[r.URL.Query().Get("subject")]
		if !ok {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(m)
	}))
	defer server.Close()
	versions := &versionRedis{versions: map[string]string{}}
	c := &controlMembershipCache{url: server.URL, token: "secret", client: server.Client(), redis: versions, entries: map[string]membershipEntry{}, floors: map[string]map[string]uint64{}}
	ctx := context.Background()
	tenant, roles, err := c.roles(ctx, "issuer", "alice")
	if err != nil || tenant != tenantA || !roles["operator"] || roles["viewer"] {
		t.Fatalf("alice tenant/role: %s %v %v", tenant, roles, err)
	}
	tenant, roles, err = c.roles(ctx, "issuer", "bob")
	if err != nil || tenant != tenantB || !roles["viewer"] {
		t.Fatalf("bob tenant/role: %s %v %v", tenant, roles, err)
	}
	foreign := membershipEvent{EventType: "membership.changed", TenantID: tenantB}
	foreign.Payload.IdentityID = identityID("issuer", "alice")
	foreign.Payload.Version = "99"
	if err := c.apply(ctx, foreign); err != nil {
		t.Fatal(err)
	}
	delete(state, "alice") // The second grant made the control-plane lookup ambiguous.
	if _, _, err := c.roles(ctx, "issuer", "alice"); err == nil {
		t.Fatal("cross-tenant grant left the old membership cached")
	}
	state["alice"] = controlMembership{TenantID: tenantA, Roles: []string{"operator"}, Version: "1", State: "active"}
	state["alice"] = controlMembership{TenantID: tenantA, Roles: nil, Version: "2", State: "revoked"}
	event := membershipEvent{EventType: "membership.changed", TenantID: tenantA}
	event.Payload.IdentityID = identityID("issuer", "alice")
	event.Payload.Version = "2"
	if err := c.apply(ctx, event); err != nil {
		t.Fatal(err)
	}
	if err := c.apply(ctx, event); err != nil {
		t.Fatal(err)
	}
	older := event
	older.Payload.Version = "1"
	if err := c.apply(ctx, older); err != nil {
		t.Fatal(err)
	}
	if value := versions.versions[membershipRedisKey(event.Payload.IdentityID, tenantA)]; value != "2" {
		t.Fatalf("version floor fell to %s", value)
	}
	if _, _, err := c.roles(ctx, "issuer", "alice"); !errors.Is(err, errMembershipRevoked) {
		t.Fatalf("revoked alice accepted: %v", err)
	}
	if tenant, _, err := c.roles(ctx, "issuer", "bob"); err != nil || tenant != tenantB {
		t.Fatalf("bob affected: %s %v", tenant, err)
	}
	versions.down = true
	bob := state["bob"]
	c.mu.Lock()
	c.entries[identityID("issuer", "bob")] = membershipEntry{value: &bob, fetched: time.Now().Add(-6 * time.Minute)}
	c.mu.Unlock()
	if _, _, err := c.roles(ctx, "issuer", "bob"); err == nil {
		t.Fatal("stale member accepted after outage")
	}
}

func TestControlMembershipRejectsMalformedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"tenantId":"t","roles":["admin"],"version":"bad","state":"active"}`))
	}))
	defer server.Close()
	c := &controlMembershipCache{url: server.URL, token: "secret", client: server.Client()}
	_, err := c.fetch(context.Background(), "issuer", "subject")
	if err == nil || !strings.Contains(err.Error(), "version") {
		t.Fatalf("malformed response accepted: %v", err)
	}
}

func TestStillValidJWTGetsSaga403AfterControlPlaneRevocation(t *testing.T) {
	const tenant = "11111111-1111-4111-8111-111111111111"
	const issuer = "https://issuer.test"
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kid": "key1", "kty": "RSA", "alg": "RS256", "use": "sig",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	}))
	defer jwks.Close()
	state := controlMembership{TenantID: tenant, Roles: []string{"viewer"}, Version: "1", State: "active"}
	lookupOutage := false
	lookup := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if lookupOutage {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if state.TenantID == "" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer lookup.Close()
	versions := &versionRedis{versions: map[string]string{}}
	cache := &controlMembershipCache{url: lookup.URL, token: "secret", client: lookup.Client(), redis: versions, entries: map[string]membershipEntry{}, floors: map[string]map[string]uint64{}}
	v := &verifier{issuer: issuer, audience: "greenguard", jwksURL: jwks.URL, membershipSource: "control-plane", membershipCache: cache, client: jwks.Client()}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"iss": issuer, "aud": "greenguard", "exp": time.Now().Add(time.Hour).Unix(), "sub": "alice", "tenant_id": "22222222-2222-4222-8222-222222222222", "roles": []string{"admin"}})
	token.Header["kid"] = "key1"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	request := func() *http.Request {
		r := httptest.NewRequest("GET", "/v1/provisioning/33333333-3333-4333-8333-333333333333", nil)
		r.Header.Set("Authorization", "Bearer "+signed)
		return r
	}
	p, err := v.verify(request())
	if err != nil || p.Tenant != tenant || !p.Roles["viewer"] || p.Roles["admin"] {
		t.Fatalf("first-party mapping: %+v %v", p, err)
	}
	cache.mu.Lock()
	delete(cache.entries, identityID(issuer, "alice"))
	cache.mu.Unlock()
	lookupOutage = true
	lookupFailure := httptest.NewRecorder()
	(&server{auth: v}).ServeHTTP(lookupFailure, request())
	if lookupFailure.Code != http.StatusServiceUnavailable {
		t.Fatalf("lookup outage misclassified as authorization denial: %d", lookupFailure.Code)
	}
	lookupOutage = false
	versions.down = true
	redisFailure := httptest.NewRecorder()
	(&server{auth: v}).ServeHTTP(redisFailure, request())
	if redisFailure.Code != http.StatusServiceUnavailable {
		t.Fatalf("Redis outage misclassified as authorization denial: %d", redisFailure.Code)
	}
	versions.down = false
	cache.setMembershipConsumerError(errMembershipUnavailable)
	unavailable := httptest.NewRecorder()
	(&server{auth: v}).ServeHTTP(unavailable, request())
	if unavailable.Code != http.StatusServiceUnavailable || !strings.Contains(unavailable.Body.String(), "membership_unavailable") {
		t.Fatalf("consumer outage misclassified: status=%d body=%s", unavailable.Code, unavailable.Body.String())
	}
	cache.setMembershipConsumerError(nil)
	state = controlMembership{TenantID: tenant, Version: "2", State: "revoked"}
	event := membershipEvent{EventType: "membership.changed", TenantID: tenant}
	event.Payload.IdentityID = identityID(issuer, "alice")
	event.Payload.Version = "2"
	if err := cache.apply(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	(&server{auth: v}).ServeHTTP(response, request())
	if response.Code != 403 {
		t.Fatalf("revoked token returned %d", response.Code)
	}
	state = controlMembership{} // An authoritative negative is still a denial.
	cache.mu.Lock()
	delete(cache.entries, identityID(issuer, "alice"))
	cache.mu.Unlock()
	missing := httptest.NewRecorder()
	(&server{auth: v}).ServeHTTP(missing, request())
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("negative membership was not a 401 denial: %d", missing.Code)
	}

}
