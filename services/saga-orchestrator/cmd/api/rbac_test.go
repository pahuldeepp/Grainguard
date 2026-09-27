package main

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const rbacTenant = "11111111-1111-4111-8111-111111111111"

// Role checks run before any store access, so a zero Store is enough: a
// request that passes RBAC would reach the store, which this test never allows.
func TestRBACDeniesEachRouteBelowItsRole(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kid": "k", "kty": "RSA", "alg": "RS256", "use": "sig",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	}))
	defer jwks.Close()
	s := &server{auth: &verifier{issuer: "issuer", audience: "greenguard", jwksURL: jwks.URL, client: jwks.Client()}}
	token := func(role string) string {
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"iss": "issuer", "aud": "greenguard",
			"exp": time.Now().Add(time.Hour).Unix(), "sub": "u", "tenant_id": rbacTenant, "roles": []string{role}})
		tok.Header["kid"] = "k"
		text, err := tok.SignedString(key)
		if err != nil {
			t.Fatal(err)
		}
		return text
	}
	saga := "/v1/provisioning/22222222-2222-4222-8222-222222222222"
	cases := []struct{ role, method, path string }{
		{"viewer", http.MethodPost, "/v1/provisioning"},
		{"viewer", http.MethodPost, saga + "/redrive"},
		{"operator", http.MethodPost, saga + "/redrive"},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, c.path, strings.NewReader("{}"))
		r.Header.Set("Authorization", "Bearer "+token(c.role))
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s %s %s: status=%d, want 403", c.role, c.method, c.path, w.Code)
		}
	}
	r := httptest.NewRequest(http.MethodDelete, saga, nil)
	r.Header.Set("Authorization", "Bearer "+token("admin"))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown method status=%d", w.Code)
	}
}

func TestMetricsRouteIsServedWithoutTenantAuth(t *testing.T) {
	served := false
	s := &server{auth: &verifier{}, metrics: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		served = true
		w.WriteHeader(http.StatusOK)
	})}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !served || w.Code != http.StatusOK {
		t.Fatalf("metrics route status=%d served=%v", w.Code, served)
	}
}
