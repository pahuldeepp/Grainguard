package main

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestVerifierCachesJWKSAndChecksTenantRolesAndSignature(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var fetches atomic.Int32
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches.Add(1)
		e := big.NewInt(int64(key.E)).Bytes()
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kid": "key1", "kty": "RSA", "alg": "RS256", "use": "sig",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(e),
		}}})
	}))
	defer jwks.Close()
	v := &verifier{issuer: "issuer", audience: "greenguard", jwksURL: jwks.URL, client: jwks.Client()}
	sign := func(claims jwt.MapClaims) string {
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
		tok.Header["kid"] = "key1"
		text, err := tok.SignedString(key)
		if err != nil {
			t.Fatal(err)
		}
		return text
	}
	claims := jwt.MapClaims{"iss": "issuer", "aud": "greenguard", "exp": time.Now().Add(time.Hour).Unix(),
		"sub": "operator-1", "tenant_id": "11111111-1111-4111-8111-111111111111", "roles": []string{"operator"}}
	for range 2 {
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("Authorization", "Bearer "+sign(claims))
		p, err := v.verify(r)
		if err != nil || !p.Roles["operator"] {
			t.Fatalf("verify: %+v %v", p, err)
		}
	}
	if fetches.Load() != 1 {
		t.Fatalf("JWKS fetches=%d, expected cache hit", fetches.Load())
	}
	bad := jwt.MapClaims{}
	for key, value := range claims {
		bad[key] = value
	}
	bad["tenant_id"] = "other"
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "Bearer "+sign(bad))
	if _, err := v.verify(r); err == nil {
		t.Fatal("invalid tenant accepted")
	}
	foreignKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	wrongSignature := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	wrongSignature.Header["kid"] = "key1"
	forged, err := wrongSignature.SignedString(foreignKey)
	if err != nil {
		t.Fatal(err)
	}
	unsigned := httptest.NewRequest("GET", "/", nil)
	unsigned.Header.Set("Authorization", "Bearer "+forged)
	if _, err := v.verify(unsigned); err == nil {
		t.Fatal("bad signature accepted")
	}
}

func TestPlainSagaAPIOnlyBindsLoopback(t *testing.T) {
	for _, address := range []string{"127.0.0.1:8092", "localhost:8092", "[::1]:8092"} {
		if err := validateListenAddress(address, false); err != nil {
			t.Fatalf("loopback %s rejected: %v", address, err)
		}
	}
	for _, address := range []string{":8092", "0.0.0.0:8092", "example.com:8092", "not-an-address"} {
		if err := validateListenAddress(address, false); err == nil {
			t.Fatalf("insecure or invalid address %s accepted", address)
		}
	}
	if err := validateListenAddress("0.0.0.0:8092", true); err != nil {
		t.Fatalf("mTLS bind rejected: %v", err)
	}
}

func TestRoutesRequireAuthentication(t *testing.T) {
	s := &server{auth: &verifier{issuer: "i", audience: "a"}}
	r := httptest.NewRequest(http.MethodGet, "/v1/provisioning/11111111-1111-4111-8111-111111111111", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", w.Code)
	}
}

func TestDexIdentityUsesCurrentFirstPartyMembership(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	issuer := "http://127.0.0.1:5556/dex"
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kid": "dex-key", "kty": "RSA", "alg": "RS256", "use": "sig",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	}))
	defer jwks.Close()
	file := filepath.Join(t.TempDir(), "memberships.json")
	const tenantA = "11111111-1111-4111-8111-111111111111"
	const tenantB = "22222222-2222-4222-8222-222222222222"
	writeMemberships := func(includeAlice bool) {
		t.Helper()
		entries := []membership{{Issuer: issuer, Subject: "bob", TenantID: tenantB, Roles: []string{"viewer"}}}
		if includeAlice {
			entries = append(entries, membership{Issuer: issuer, Subject: "alice", TenantID: tenantA, Roles: []string{"operator"}})
		}
		data, _ := json.Marshal(entries)
		if err := os.WriteFile(file, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeMemberships(true)
	v := &verifier{issuer: issuer, audience: "greenguard-dashboard", jwksURL: jwks.URL, membershipFile: file, client: jwks.Client()}
	verify := func(subject string) (principal, error) {
		t.Helper()
		// Malicious tenant and admin claims must never override local membership.
		claims := jwt.MapClaims{"iss": issuer, "aud": "greenguard-dashboard", "exp": time.Now().Add(time.Hour).Unix(),
			"sub": subject, "tenant_id": tenantB, "roles": []string{"admin"}}
		token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
		token.Header["kid"] = "dex-key"
		signed, err := token.SignedString(key)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("GET", "/v1/provisioning", nil)
		r.Header.Set("Authorization", "Bearer "+signed)
		return v.verify(r)
	}
	alice, err := verify("alice")
	if err != nil || alice.Tenant != tenantA || !alice.Roles["operator"] || alice.Roles["admin"] {
		t.Fatalf("alice membership not authoritative: %+v %v", alice, err)
	}
	bob, err := verify("bob")
	if err != nil || bob.Tenant != tenantB || !bob.Roles["viewer"] || bob.Roles["admin"] {
		t.Fatalf("bob crossed tenants or gained role: %+v %v", bob, err)
	}
	writeMemberships(false)
	if _, err := verify("alice"); err == nil {
		t.Fatal("revoked membership still accepted")
	}
	if _, err := verify("unknown"); err == nil {
		t.Fatal("unmapped identity accepted")
	}
	if err := os.WriteFile(file, []byte("invalid JSON"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := verify("bob"); err == nil {
		t.Fatal("malformed membership file did not fail closed")
	}
}
