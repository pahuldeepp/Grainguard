package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	authTenant   = "6f1c2a4e-8b3d-4c5e-9a7f-1d2e3f4a5b6c"
	authBearer   = "Bearer "
	authClaimSub = "sub"
	authClaimTen = "tenant_id"
	authClaimExp = "exp"
	authClaimRol = "roles"
)

type authKey struct {
	kid string
	key *rsa.PrivateKey
}

type testIssuer struct {
	Issuer   string
	Audience string
	URL      string

	srv    *httptest.Server
	mu     sync.Mutex
	keys   []authKey
	signer authKey
	status int
	delay  time.Duration
	raw    string
	hits   atomic.Int32
}

func authGenKey(t *testing.T, kid string) authKey {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return authKey{kid: kid, key: k}
}

func newTestIssuer(t *testing.T) *testIssuer {
	t.Helper()
	first := authGenKey(t, "kid-1")
	i := &testIssuer{Issuer: "https://issuer.test", Audience: "greenguard", keys: []authKey{first}, signer: first, status: http.StatusOK}
	i.srv = httptest.NewServer(http.HandlerFunc(i.serve))
	i.URL = i.srv.URL
	t.Cleanup(i.srv.Close)
	return i
}

func (i *testIssuer) serve(w http.ResponseWriter, _ *http.Request) {
	i.hits.Add(1)
	i.mu.Lock()
	status, delay, raw := i.status, i.delay, i.raw
	body := authJWKS(i.keys)
	i.mu.Unlock()
	time.Sleep(delay)
	if status != http.StatusOK {
		w.WriteHeader(status)
		return
	}
	if raw != "" {
		body = []byte(raw)
	}
	_, _ = w.Write(body)
}

func authB64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func authJWKS(keys []authKey) []byte {
	entries := []map[string]string{}
	for _, k := range keys {
		entries = append(entries, map[string]string{
			"kty": "RSA", "kid": k.kid, "alg": "RS256", "use": "sig",
			"n": authB64(k.key.N.Bytes()), "e": "AQAB",
		})
	}
	out, _ := json.Marshal(map[string]any{"keys": entries})
	return out
}

func (i *testIssuer) sign(claims map[string]any) string {
	i.mu.Lock()
	signer := i.signer
	i.mu.Unlock()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, i.claims(claims))
	tok.Header["kid"] = signer.kid
	s, err := tok.SignedString(signer.key)
	if err != nil {
		panic(err)
	}
	return s
}

func (i *testIssuer) claims(overrides map[string]any) jwt.MapClaims {
	now := time.Now()
	c := jwt.MapClaims{
		"iss": i.Issuer, "aud": i.Audience, authClaimExp: now.Add(5 * time.Minute).Unix(), "iat": now.Unix(),
		authClaimSub: "user-1", authClaimTen: authTenant, authClaimRol: []string{RoleOperator},
	}
	for k, v := range overrides {
		if v == nil {
			delete(c, k)
		} else {
			c[k] = v
		}
	}
	return c
}

func (i *testIssuer) config() AuthConfig {
	return AuthConfig{
		Issuer: i.Issuer, Audience: i.Audience, JWKSURL: i.URL,
		CacheMaxAge: time.Minute, Cooldown: 50 * time.Millisecond, Timeout: 200 * time.Millisecond,
	}
}

func (i *testIssuer) verifier(t *testing.T) *Verifier {
	t.Helper()
	v, err := NewVerifier(i.config())
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func (i *testIssuer) rotate() {
	i.mu.Lock()
	defer i.mu.Unlock()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	next := authKey{kid: "kid-" + authB64([]byte{byte(len(i.keys) + 2)}), key: k}
	i.keys = append(i.keys, next)
	i.signer = next
}

func (i *testIssuer) set(f func()) {
	i.mu.Lock()
	defer i.mu.Unlock()
	f()
}

func authAlgNone(t *testing.T, i *testIssuer) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodNone, i.claims(nil))
	tok.Header["kid"] = "kid-1"
	s, err := tok.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func authHS256WithPublicKey(t *testing.T, i *testIssuer) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(&i.signer.key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, i.claims(nil))
	tok.Header["kid"] = "kid-1"
	s, err := tok.SignedString(der)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func authWantCode(t *testing.T, err error, status int, code string) {
	t.Helper()
	var ae *AuthError
	if !errors.As(err, &ae) {
		t.Fatalf("want AuthError %s, got %v", code, err)
	}
	if ae.Status != status || ae.Code != code || ae.Error() != code {
		t.Fatalf("got %d %s, want %d %s", ae.Status, ae.Code, status, code)
	}
}

func TestAuthValidToken(t *testing.T) {
	i := newTestIssuer(t)
	p, err := i.verifier(t).Verify(authBearer + i.sign(map[string]any{authClaimRol: []string{"viewer", "admin", "viewer", "device"}}))
	if err != nil {
		t.Fatal(err)
	}
	if p.Subject != "user-1" || p.TenantID != authTenant || strings.Join(p.Roles, ",") != "viewer,admin,device" {
		t.Fatalf("unexpected principal %+v", p)
	}
}

func TestAuthHeaderParsing(t *testing.T) {
	i := newTestIssuer(t)
	v := i.verifier(t)
	tok := i.sign(nil)
	if _, err := v.Verify("bEaReR " + tok); err != nil {
		t.Fatalf("case-insensitive scheme rejected: %v", err)
	}
	_, err := v.Verify("")
	authWantCode(t, err, 401, "missing_token")
	for _, h := range []string{"Bearer", "Bearer ", "Bearer  " + tok, "Bearer " + tok + " x", "Basic " + tok, tok, "Bearer\t" + tok} {
		_, err := v.Verify(h)
		authWantCode(t, err, 401, "malformed_header")
	}
}

func TestAuthRejectsBadTokens(t *testing.T) {
	i := newTestIssuer(t)
	v := i.verifier(t)
	other := newTestIssuer(t)
	other.signer.kid = "kid-1"
	cases := map[string]string{
		"alg none":          authAlgNone(t, i),
		"hs256 confusion":   authHS256WithPublicKey(t, i),
		"garbage":           "not.a.jwt",
		"wrong issuer":      i.sign(map[string]any{"iss": "https://evil"}),
		"wrong audience":    i.sign(map[string]any{"aud": "other"}),
		"missing exp":       i.sign(map[string]any{authClaimExp: nil}),
		"nbf future":        i.sign(map[string]any{"nbf": time.Now().Add(time.Hour).Unix()}),
		"foreign key":       other.sign(nil),
		"exp beyond leeway": i.sign(map[string]any{authClaimExp: time.Now().Add(-time.Minute).Unix()}),
	}
	for name, tok := range cases {
		_, err := v.Verify(authBearer + tok)
		if name == "exp beyond leeway" {
			authWantCode(t, err, 401, "expired_token")
			continue
		}
		authWantCode(t, err, 401, "invalid_token")
		if strings.Contains(err.Error(), tok) || strings.Contains(err.Error(), "jwt") {
			t.Fatalf("%s: error leaks detail: %v", name, err)
		}
	}
}

func TestAuthClockToleranceAndInjectedClock(t *testing.T) {
	i := newTestIssuer(t)
	v := i.verifier(t)
	if _, err := v.Verify(authBearer + i.sign(map[string]any{authClaimExp: time.Now().Add(-10 * time.Second).Unix()})); err != nil {
		t.Fatalf("within tolerance rejected: %v", err)
	}
	cfg := i.config()
	cfg.Now = func() time.Time { return time.Now().Add(time.Hour) }
	late, err := NewVerifier(cfg)
	if err != nil {
		t.Fatal(err)
	}
	_, err = late.Verify(authBearer + i.sign(nil))
	authWantCode(t, err, 401, "expired_token")
}

func TestAuthClaims(t *testing.T) {
	i := newTestIssuer(t)
	v := i.verifier(t)
	bad := map[string]map[string]any{
		"no sub":         {authClaimSub: nil},
		"empty sub":      {authClaimSub: ""},
		"numeric sub":    {authClaimSub: 7},
		"no tenant":      {authClaimTen: nil},
		"uppercase":      {authClaimTen: strings.ToUpper(authTenant)},
		"nil uuid":       {authClaimTen: "00000000-0000-0000-0000-000000000000"},
		"numeric tenant": {authClaimTen: 5},
		"no roles":       {authClaimRol: nil},
		"empty roles":    {authClaimRol: []string{}},
		"unknown role":   {authClaimRol: []string{"root"}},
		"string roles":   {authClaimRol: "admin"},
		"non-string":     {authClaimRol: []any{1}},
	}
	for name, override := range bad {
		_, err := v.Verify(authBearer + i.sign(override))
		var ae *AuthError
		if !errors.As(err, &ae) || ae.Code != "invalid_claims" || ae.Status != 401 {
			t.Fatalf("%s: got %v", name, err)
		}
	}
}

func TestAuthRequireRole(t *testing.T) {
	p := Principal{Roles: []string{RoleAdmin}}
	if err := RequireRole(p, RoleViewer, RoleAdmin); err != nil {
		t.Fatal(err)
	}
	authWantCode(t, RequireRole(p, RoleOperator, RoleDevice), 403, "insufficient_role")
	authWantCode(t, RequireRole(p), 403, "insufficient_role")
}

func TestAuthJWKSCachedAcrossVerifies(t *testing.T) {
	i := newTestIssuer(t)
	v := i.verifier(t)
	for range 3 {
		if _, err := v.Verify(authBearer + i.sign(nil)); err != nil {
			t.Fatal(err)
		}
	}
	if n := i.hits.Load(); n != 1 {
		t.Fatalf("JWKS fetched %d times, want 1", n)
	}
}

func TestAuthUnknownKidCooldownAndRotation(t *testing.T) {
	i := newTestIssuer(t)
	cfg := i.config()
	cfg.Cooldown = 400 * time.Millisecond
	v, err := NewVerifier(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.Verify(authBearer + i.sign(nil)); err != nil {
		t.Fatal(err)
	}
	i.rotate()
	rotated := i.sign(nil)
	_, err = v.Verify(authBearer + rotated)
	authWantCode(t, err, 401, "invalid_token")
	if n := i.hits.Load(); n != 1 {
		t.Fatalf("cooldown ignored: %d fetches", n)
	}
	time.Sleep(450 * time.Millisecond)
	if _, err := v.Verify(authBearer + rotated); err != nil {
		t.Fatalf("rotated key not picked up: %v", err)
	}
	if n := i.hits.Load(); n != 2 {
		t.Fatalf("want 2 fetches, got %d", n)
	}
}

func TestAuthTokenWithoutKid(t *testing.T) {
	i := newTestIssuer(t)
	v := i.verifier(t)
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, i.claims(nil))
	s, err := tok.SignedString(i.signer.key)
	if err != nil {
		t.Fatal(err)
	}
	_, err = v.Verify(authBearer + s)
	authWantCode(t, err, 401, "invalid_token")
	if i.hits.Load() != 0 {
		t.Fatal("kid-less token must not trigger a fetch")
	}
}

func TestAuthJWKSFailuresAre503ThenRecover(t *testing.T) {
	i := newTestIssuer(t)
	v := i.verifier(t)
	tok := authBearer + i.sign(nil)
	i.set(func() { i.status = http.StatusInternalServerError })
	_, err := v.Verify(tok)
	authWantCode(t, err, 503, "auth_unavailable")
	_, err = v.Verify(tok)
	authWantCode(t, err, 503, "auth_unavailable")
	if n := i.hits.Load(); n != 1 {
		t.Fatalf("failure not rate limited: %d fetches", n)
	}
	i.set(func() { i.status = http.StatusOK })
	time.Sleep(80 * time.Millisecond)
	if _, err := v.Verify(tok); err != nil {
		t.Fatalf("no recovery: %v", err)
	}
}

func TestAuthJWKSTimeoutAndBadBodies(t *testing.T) {
	i := newTestIssuer(t)
	tok := authBearer + i.sign(nil)
	i.set(func() { i.delay = 400 * time.Millisecond })
	_, err := i.verifier(t).Verify(tok)
	authWantCode(t, err, 503, "auth_unavailable")
	i.set(func() { i.delay = 0; i.raw = "{not json" })
	_, err = i.verifier(t).Verify(tok)
	authWantCode(t, err, 503, "auth_unavailable")
}

func TestAuthJWKSUnreachable(t *testing.T) {
	i := newTestIssuer(t)
	tok := authBearer + i.sign(nil)
	i.srv.Close()
	_, err := i.verifier(t).Verify(tok)
	authWantCode(t, err, 503, "auth_unavailable")
}

func TestAuthJWKSSkipsUnusableKeys(t *testing.T) {
	i := newTestIssuer(t)
	good := authJWKS(i.keys)
	var doc map[string][]map[string]string
	if err := json.Unmarshal(good, &doc); err != nil {
		t.Fatal(err)
	}
	junk := []map[string]string{
		{"kty": "EC", "kid": "ec"},
		{"kty": "RSA", "kid": ""},
		{"kty": "RSA", "kid": "bad-n", "n": "***", "e": "AQAB"},
		{"kty": "RSA", "kid": "bad-e", "n": "AQAB", "e": "***"},
		{"kty": "RSA", "kid": "empty", "n": "", "e": ""},
		{"kty": "RSA", "kid": "huge-e", "n": "AQAB", "e": "AQAAAAAB"},
	}
	doc["keys"] = append(junk, doc["keys"]...)
	raw, _ := json.Marshal(doc)
	i.set(func() { i.raw = string(raw) })
	v := i.verifier(t)
	if _, err := v.Verify(authBearer + i.sign(nil)); err != nil {
		t.Fatal(err)
	}
	_, err := v.Verify(authBearer + authAlgNone(t, i))
	authWantCode(t, err, 401, "invalid_token")
}

func TestAuthStaleCacheRefreshes(t *testing.T) {
	i := newTestIssuer(t)
	cfg := i.config()
	cfg.CacheMaxAge = 20 * time.Millisecond
	v, err := NewVerifier(cfg)
	if err != nil {
		t.Fatal(err)
	}
	tok := authBearer + i.sign(nil)
	if _, err := v.Verify(tok); err != nil {
		t.Fatal(err)
	}
	time.Sleep(80 * time.Millisecond)
	if _, err := v.Verify(tok); err != nil {
		t.Fatal(err)
	}
	if n := i.hits.Load(); n != 2 {
		t.Fatalf("want 2 fetches, got %d", n)
	}
}

func TestAuthKeyfuncOverride(t *testing.T) {
	i := newTestIssuer(t)
	cfg := AuthConfig{Issuer: i.Issuer, Audience: i.Audience, Keyfunc: func(*jwt.Token) (any, error) { return &i.signer.key.PublicKey, nil }}
	v, err := NewVerifier(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.Verify(authBearer + i.sign(nil)); err != nil {
		t.Fatal(err)
	}
	cfg.Keyfunc = func(*jwt.Token) (any, error) { return nil, errors.New("boom secret") }
	v, _ = NewVerifier(cfg)
	_, err = v.Verify(authBearer + i.sign(nil))
	authWantCode(t, err, 401, "invalid_token")
}

func TestAuthNewVerifierValidation(t *testing.T) {
	bad := []AuthConfig{
		{Audience: "a", JWKSURL: "https://x"},
		{Issuer: "i", JWKSURL: "https://x"},
		{Issuer: "i", Audience: "a"},
		{Issuer: "i", Audience: "a", JWKSURL: "ftp://x"},
		{Issuer: "i", Audience: "a", JWKSURL: "https://"},
		{Issuer: "i", Audience: "a", JWKSURL: "http://[::1"},
	}
	for _, cfg := range bad {
		if v, err := NewVerifier(cfg); err == nil || v != nil {
			t.Fatalf("expected error for %+v", cfg)
		}
	}
	v, err := NewVerifier(AuthConfig{Issuer: "i", Audience: "a", JWKSURL: "https://example.com/jwks"})
	if err != nil || v == nil {
		t.Fatal(err)
	}
}

func TestAuthAuthErrorString(t *testing.T) {
	var err error = &AuthError{Status: 401, Code: "x"}
	if err.Error() != "x" {
		t.Fatal(err)
	}
}

func authStaleVerifier(t *testing.T, i *testIssuer, maxAge, maxStale time.Duration) *Verifier {
	t.Helper()
	cfg := i.config()
	cfg.CacheMaxAge, cfg.MaxStale, cfg.Cooldown = maxAge, maxStale, 5*time.Millisecond
	v, err := NewVerifier(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestAuthServesAKnownKeyBrieflyWhileTheKeyServerIsDownThenFailsClosed(t *testing.T) {
	i := newTestIssuer(t)
	v := authStaleVerifier(t, i, 30*time.Millisecond, 300*time.Millisecond)
	tok := authBearer + i.sign(nil)
	if _, err := v.Verify(tok); err != nil {
		t.Fatalf("warm-up verify: %v", err)
	}
	i.set(func() { i.status = http.StatusInternalServerError })
	time.Sleep(60 * time.Millisecond)
	if _, err := v.Verify(tok); err != nil {
		t.Fatalf("a cached key must keep working for a short outage: %v", err)
	}
	if i.hits.Load() < 2 {
		t.Fatal("the outage path must have tried to refresh")
	}
	time.Sleep(350 * time.Millisecond)
	_, err := v.Verify(tok)
	authWantCode(t, err, 503, "auth_unavailable")
	i.set(func() { i.status = http.StatusOK })
	time.Sleep(20 * time.Millisecond)
	if _, err := v.Verify(tok); err != nil {
		t.Fatalf("recovery after the outage: %v", err)
	}
}

func TestAuthAnUnknownKeyIsStill401WhileTheKeyServerIsDown(t *testing.T) {
	i := newTestIssuer(t)
	v := authStaleVerifier(t, i, 30*time.Millisecond, 300*time.Millisecond)
	if _, err := v.Verify(authBearer + i.sign(nil)); err != nil {
		t.Fatal(err)
	}
	i.rotate()
	rotated := authBearer + i.sign(nil)
	i.set(func() { i.status = http.StatusInternalServerError })
	time.Sleep(60 * time.Millisecond)
	_, err := v.Verify(rotated)
	authWantCode(t, err, 401, "invalid_token")
}
