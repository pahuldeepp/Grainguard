package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func signedReadToken(t *testing.T, key *rsa.PrivateKey, audience string, roles []string, notBefore ...int64) string {
	t.Helper()
	enc := func(v any) string {
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	header := enc(map[string]string{"alg": "RS256", "kid": "read-key"})
	claimSet := map[string]any{"iss": "https://issuer.example", "sub": "operator-1", "aud": audience, "exp": time.Now().Add(time.Minute).Unix(), "tenant_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "roles": roles}
	if len(notBefore) != 0 {
		claimSet["nbf"] = notBefore[0]
	}
	claims := enc(claimSet)
	input := header + "." + claims
	digest := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func TestOwnerMembershipFileRefreshesAndMapsTenantAndRoles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "memberships.json")
	contents := `[{"issuer":"https://issuer.example","subject":"operator-1","tenantId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","roles":["operator"]}]`
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	memberships, err := loadAPIMemberships(path)
	if err != nil {
		t.Fatal(err)
	}
	api := &notificationAPI{memberships: memberships, membershipPath: path, membershipLastSuccess: time.Now(), membershipCheckedAt: time.Now()}
	if got, ok, err := api.membership(context.Background(), "https://issuer.example", "operator-1"); err != nil || !ok || got.Tenant != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" || !hasValue(got.Roles, "operator") {
		t.Fatalf("initial membership not loaded: %+v %v", got, ok)
	}
	contents = `[{"issuer":"https://issuer.example","subject":"operator-1","tenantId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","roles":["viewer"]}]`
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	api.membershipCheckedAt = time.Time{}
	if got, ok, err := api.membership(context.Background(), "https://issuer.example", "operator-1"); err != nil || !ok || got.Tenant != "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" || !hasValue(got.Roles, "viewer") {
		t.Fatalf("membership refresh not applied: %+v %v", got, ok)
	}
}

func TestStaleMembershipFileNeverFallsBackToLastKnownRoles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "memberships.json")
	if err := os.WriteFile(path, []byte(`[{"issuer":"https://issuer.example","subject":"operator-1","tenantId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","roles":["operator"]}]`), 0600); err != nil {
		t.Fatal(err)
	}
	memberships, err := loadAPIMemberships(path)
	if err != nil {
		t.Fatal(err)
	}
	api := &notificationAPI{memberships: memberships, membershipPath: path, membershipLastSuccess: time.Now().Add(-6 * time.Minute), membershipCheckedAt: time.Time{}}
	if err := os.WriteFile(path, []byte("not valid JSON"), 0600); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, ok, err := api.membership(context.Background(), "https://issuer.example", "operator-1"); err != nil || ok {
			t.Fatalf("stale operator membership was accepted: ok=%v err=%v", ok, err)
		}
	}
	if err := os.WriteFile(path, []byte(`[{"issuer":"https://issuer.example","subject":"operator-1","tenantId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","roles":["viewer"]}]`), 0600); err != nil {
		t.Fatal(err)
	}
	api.membershipCheckedAt = time.Time{}
	if got, ok, err := api.membership(context.Background(), "https://issuer.example", "operator-1"); err != nil || !ok || got.Tenant != "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" || !hasValue(got.Roles, "viewer") {
		t.Fatalf("recovered membership file did not replace stale data: %+v %v %v", got, ok, err)
	}
}

func TestControlPlaneMembershipLookupUsesVerifiedPrincipalAndFailsClosed(t *testing.T) {
	var sawIssuer, sawSubject, sawToken string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawIssuer = r.URL.Query().Get("issuer")
		sawSubject = r.URL.Query().Get("subject")
		sawToken = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"tenantId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","roles":["operator"],"version":"7","state":"active"}`))
	}))
	defer server.Close()
	api := &notificationAPI{membershipSource: "control-plane", controlPlaneURL: server.URL, controlLookupToken: strings.Repeat("s", 32), allowInsecureMembership: true, client: server.Client()}
	got, ok, err := api.membership(context.Background(), "https://issuer.example", "principal-123")
	if err != nil || !ok || got.Tenant != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" || !hasValue(got.Roles, "operator") {
		t.Fatalf("active membership was not accepted: %+v %v %v", got, ok, err)
	}
	if sawIssuer != "https://issuer.example" || sawSubject != "principal-123" || sawToken != "Bearer "+strings.Repeat("s", 32) {
		t.Fatalf("lookup did not use verified identity and service credential: issuer=%q subject=%q token=%q", sawIssuer, sawSubject, sawToken)
	}
	api.allowInsecureMembership = false
	if _, _, err := api.membership(context.Background(), "https://issuer.example", "principal-123"); err == nil {
		t.Fatal("insecure lookup URL accepted without explicit local opt-in")
	}
}

func TestNotificationAPIRequiresVerifiedOperatorAndAudience(t *testing.T) {
	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	n := base64.RawURLEncoding.EncodeToString(private.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(private.E)).Bytes())
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]string{"kty": "RSA", "use": "sig", "kid": "read-key", "n": n, "e": e}}})
	}))
	defer jwks.Close()
	api := &notificationAPI{issuer: "https://issuer.example", audience: "greenguard-api", jwksURL: jwks.URL, cursorKey: strings.Repeat("k", 32), client: jwks.Client(), memberships: map[string]apiMembership{"https://issuer.example|operator-1": {Tenant: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Roles: []string{"operator"}}}}
	request := func(token string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/internal/v1/notification-intents", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		return r
	}
	p, status, err := api.verify(request(signedReadToken(t, private, "greenguard-api", []string{"operator"})))
	if err != nil || status != 0 || p.Tenant != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" {
		t.Fatalf("operator was not accepted: principal=%+v status=%d err=%v", p, status, err)
	}
	// Signed token role claims do not grant access; the verified issuer/subject membership does.
	_, status, _ = api.verify(request(signedReadToken(t, private, "greenguard-api", []string{"viewer"})))
	if status != 0 {
		t.Fatalf("IdP role claim overrode GreenGuard membership: %d", status)
	}
	api.memberships["https://issuer.example|operator-1"] = apiMembership{Tenant: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Roles: []string{"viewer"}}
	_, status, _ = api.verify(request(signedReadToken(t, private, "greenguard-api", []string{"operator"})))
	if status != http.StatusForbidden {
		t.Fatalf("viewer status = %d, want 403", status)
	}
	_, status, _ = api.verify(request(signedReadToken(t, private, "wrong-audience", []string{"operator"})))
	if status != http.StatusUnauthorized {
		t.Fatalf("wrong audience status = %d, want 401", status)
	}
	_, status, _ = api.verify(request(signedReadToken(t, private, "greenguard-api", []string{"operator"}, time.Now().Add(time.Minute).Unix())))
	if status != http.StatusUnauthorized {
		t.Fatalf("not-yet-valid token status = %d, want 401", status)
	}
}

func TestUnknownJWKSKeyRefreshIsThrottledWithoutEvictingCache(t *testing.T) {
	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	n := base64.RawURLEncoding.EncodeToString(private.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(private.E)).Bytes())
	fetches := 0
	fail := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fetches++
		if fail {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]string{"kty": "RSA", "use": "sig", "kid": "known", "n": n, "e": e}}})
	}))
	defer server.Close()
	api := &notificationAPI{jwksURL: server.URL, client: server.Client()}
	known, err := api.key(context.Background(), "known")
	if err != nil || known == nil || fetches != 1 {
		t.Fatalf("initial JWKS fetch failed: key=%v fetches=%d err=%v", known, fetches, err)
	}
	for range 3 {
		if _, err := api.key(context.Background(), "attacker-controlled-kid"); err == nil {
			t.Fatal("unknown kid accepted")
		}
	}
	if fetches != 1 {
		t.Fatalf("unknown kids bypassed refresh throttle: %d JWKS requests", fetches)
	}
	if cached, err := api.key(context.Background(), "known"); err != nil || cached != known {
		t.Fatalf("unknown kid evicted the cached signing key: %v", err)
	}
	fail = true
	api.keysUntil = time.Now().Add(-time.Second)
	api.keysFetchedAt = time.Now().Add(-time.Minute)
	if _, err := api.key(context.Background(), "known"); err == nil {
		t.Fatal("failed JWKS refresh unexpectedly succeeded")
	}
	if cached, err := api.key(context.Background(), "known"); err != nil || cached != known {
		t.Fatalf("cached key unavailable during refresh grace: %v", err)
	}
	if _, err := api.key(context.Background(), "another-unknown-kid"); err == nil || fetches != 2 {
		t.Fatalf("refresh failure was not throttled: fetches=%d err=%v", fetches, err)
	}
}

func TestNotificationHistoryNeverReturnsSeededCriticalIntent(t *testing.T) {
	db := dbPool(t)
	tenant, alert := randomUUID(), randomUUID()
	warningIntent, criticalIntent := randomUUID(), randomUUID()
	eventWarning, eventCritical := randomUUID(), randomUUID()
	episodeWarning, episodeCritical := randomUUID(), randomUUID()
	correlationWarning, correlationCritical := randomUUID(), randomUUID()
	trace := "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	if err := WithTenant(context.Background(), db, tenant, func(ctx context.Context, tx pgx.Tx) error {
		for _, event := range []string{eventWarning, eventCritical} {
			if _, err := tx.Exec(ctx, `INSERT INTO inbox (tenant_id,event_id,event_type,source_topic,source_partition,source_offset) VALUES ($1,$2,'test.seed','test',0,0)`, tenant, event); err != nil {
				return err
			}
		}
		for _, row := range []struct {
			intent, event, episode, correlation, severity, channel string
		}{
			{warningIntent, eventWarning, episodeWarning, correlationWarning, "warning", "email"},
			{criticalIntent, eventCritical, episodeCritical, correlationCritical, "critical", "sms"},
		} {
			attempts := 2
			if row.severity == "critical" {
				attempts = 5
			}
			if _, err := tx.Exec(ctx, `INSERT INTO notification_intents (tenant_id,intent_id,source_event_id,alert_id,episode_id,transition_version,transition,severity,channel,attempts,correlation_id,traceparent) VALUES ($1,$2,$3,$4,$5,1,'alert.opened',$6,$7,$8,$9,$10)`, tenant, row.intent, row.event, alert, row.episode, row.severity, row.channel, attempts, row.correlation, trace); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	n := base64.RawURLEncoding.EncodeToString(private.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(private.E)).Bytes())
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]string{"kty": "RSA", "use": "sig", "kid": "read-key", "n": n, "e": e}}})
	}))
	defer jwks.Close()
	api := &notificationAPI{
		db: db, issuer: "https://issuer.example", audience: "greenguard-api", jwksURL: jwks.URL,
		cursorKey: strings.Repeat("k", 32), client: jwks.Client(),
		memberships: map[string]apiMembership{"https://issuer.example|operator-1": {Tenant: tenant, Roles: []string{"operator"}}},
	}
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/notification-intents?alertId="+alert+"&limit=100", nil)
	request.Header.Set("Authorization", "Bearer "+signedReadToken(t, private, "greenguard-api", []string{"operator"}))
	response := httptest.NewRecorder()
	api.handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("owner read status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Items []struct {
			IntentID string `json:"intentId"`
			Severity string `json:"severity"`
			Attempts int    `json:"dispatchAttempts"`
		} `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 1 || body.Items[0].IntentID != warningIntent || body.Items[0].Severity != "warning" || body.Items[0].Attempts != 2 {
		t.Fatalf("warning-only history returned unexpected seeded rows: %+v", body.Items)
	}
}

func TestNotificationOwnerCursorIsSignedAndTenantAlertBound(t *testing.T) {
	api := &notificationAPI{cursorKey: strings.Repeat("k", 32)}
	c := intentCursor{Tenant: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Alert: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Version: "42", Channel: "email", Intent: "11111111-1111-4111-8111-111111111111"}
	token := api.encodeCursor(c)
	if got, err := api.decodeCursor(token, c.Tenant, c.Alert); err != nil || got != c {
		t.Fatalf("valid cursor rejected: %+v %v", got, err)
	}
	if _, err := api.decodeCursor(token, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", c.Alert); err == nil {
		t.Fatal("cursor accepted for another tenant")
	}
	if _, err := api.decodeCursor(token, c.Tenant, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"); err == nil {
		t.Fatal("cursor accepted for another alert")
	}
	if _, err := api.decodeCursor(token+strconv.Itoa(1), c.Tenant, c.Alert); err == nil {
		t.Fatal("tampered cursor accepted")
	}
}
