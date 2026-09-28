package main

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	common "greenguard.local/go-common"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// notificationAPI exposes only the jobs-worker-owned, bounded warning-intent ledger.
// The bearer token is verified here; caller-supplied tenant selectors are never accepted.
type notificationAPI struct {
	db                                   TxStarter
	issuer, audience, jwksURL, cursorKey string
	client                               *http.Client
	mu                                   sync.Mutex
	membershipMu                         sync.Mutex
	keys                                 map[string]*rsa.PublicKey
	keysUntil                            time.Time
	keysFetchedAt                        time.Time
	memberships                          map[string]apiMembership
	membershipPath                       string
	membershipCheckedAt                  time.Time
	membershipLastSuccess                time.Time
	membershipStale                      bool
	membershipSource                     string
	controlPlaneURL                      string
	controlLookupToken                   string
	allowInsecureMembership              bool
	controlMeshMTLS                      bool
}

type apiPrincipal struct {
	Tenant, Subject string
	Roles           []string
}
type jwtHeader struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
}
type jwksDocument struct {
	Keys []struct{ Kty, Use, Kid, N, E string }
}
type jwtClaims struct {
	Iss string          `json:"iss"`
	Sub string          `json:"sub"`
	Aud json.RawMessage `json:"aud"`
	Exp int64           `json:"exp"`
	Nbf int64           `json:"nbf"`
}

type apiMembership struct {
	Tenant string   `json:"tenantId"`
	Roles  []string `json:"roles"`
}
type apiMembershipEntry struct {
	Issuer  string   `json:"issuer"`
	Subject string   `json:"subject"`
	Tenant  string   `json:"tenantId"`
	Roles   []string `json:"roles"`
}

func loadAPIMemberships(path string) (map[string]apiMembership, error) {
	result := make(map[string]apiMembership)
	if path == "" {
		return result, nil
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read auth membership file: %w", err)
	}
	var entries []apiMembershipEntry
	if err := json.Unmarshal(contents, &entries); err != nil {
		return nil, errors.New("invalid auth membership file")
	}
	for _, entry := range entries {
		if entry.Issuer == "" || entry.Subject == "" || !uuidPattern.MatchString(entry.Tenant) || entry.Roles == nil {
			return nil, errors.New("invalid auth membership entry")
		}
		for _, role := range entry.Roles {
			if role != "viewer" && role != "operator" && role != "admin" && role != "device" {
				return nil, errors.New("invalid auth membership role")
			}
		}
		key := entry.Issuer + "|" + entry.Subject
		if _, exists := result[key]; exists {
			return nil, errors.New("duplicate auth membership")
		}
		result[key] = apiMembership{Tenant: entry.Tenant, Roles: entry.Roles}
	}
	return result, nil
}

func (a *notificationAPI) membership(ctx context.Context, issuer, subject string) (apiMembership, bool, error) {
	if a.membershipSource == "control-plane" {
		return a.lookupMembership(ctx, issuer, subject)
	}
	a.membershipMu.Lock()
	defer a.membershipMu.Unlock()
	now := time.Now()
	if a.membershipPath != "" && (a.memberships == nil || now.Sub(a.membershipCheckedAt) >= 30*time.Second) {
		a.membershipCheckedAt = now
		if latest, err := loadAPIMemberships(a.membershipPath); err == nil {
			a.memberships = latest
			a.membershipLastSuccess = now
			a.membershipStale = false
		} else if now.Sub(a.membershipLastSuccess) >= 5*time.Minute {
			a.membershipStale = true
			return apiMembership{}, false, nil
		}
	}
	if a.membershipStale {
		return apiMembership{}, false, nil
	}
	entry, ok := a.memberships[issuer+"|"+subject]
	return entry, ok, nil
}

func (a *notificationAPI) lookupMembership(ctx context.Context, issuer, subject string) (apiMembership, bool, error) {
	u, err := url.Parse(a.controlPlaneURL)
	meshHTTP := err == nil && u != nil && a.controlMeshMTLS && common.InternalMeshHost(u.Hostname())
	if err != nil || u.Hostname() == "" || (u.Scheme != "https" && !(u.Scheme == "http" && (a.allowInsecureMembership || meshHTTP))) {
		return apiMembership{}, false, errors.New("membership lookup URL is not secure")
	}
	u.Path, err = url.JoinPath(u.Path, "/v1/internal/memberships")
	if err != nil {
		return apiMembership{}, false, err
	}
	query := u.Query()
	query.Set("issuer", issuer)
	query.Set("subject", subject)
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return apiMembership{}, false, err
	}
	req.Header.Set("Authorization", "Bearer "+a.controlLookupToken)
	resp, err := a.client.Do(req)
	if err != nil {
		return apiMembership{}, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return apiMembership{}, false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return apiMembership{}, false, fmt.Errorf("membership lookup status %d", resp.StatusCode)
	}
	var result struct {
		Tenant  string   `json:"tenantId"`
		Roles   []string `json:"roles"`
		Version string   `json:"version"`
		State   string   `json:"state"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&result) != nil || !uuidPattern.MatchString(result.Tenant) || (result.State != "active" && result.State != "revoked") || result.Roles == nil {
		return apiMembership{}, false, errors.New("malformed membership response")
	}
	version, versionErr := strconv.ParseInt(result.Version, 10, 64)
	if versionErr != nil || version < 1 {
		return apiMembership{}, false, errors.New("malformed membership version")
	}
	if result.State == "revoked" && len(result.Roles) != 0 || result.State == "active" && len(result.Roles) == 0 {
		return apiMembership{}, false, errors.New("malformed membership state")
	}
	for _, role := range result.Roles {
		if role != "viewer" && role != "operator" && role != "admin" {
			return apiMembership{}, false, errors.New("malformed membership role")
		}
	}
	if result.State != "active" {
		return apiMembership{}, false, nil
	}
	return apiMembership{Tenant: result.Tenant, Roles: result.Roles}, true, nil
}

func (a *notificationAPI) configured() bool {
	if a.issuer == "" || a.audience == "" || a.jwksURL == "" || len(a.cursorKey) < 32 {
		return false
	}
	if a.membershipSource == "control-plane" {
		return a.controlPlaneURL != "" && len(a.controlLookupToken) >= 32
	}
	_, _, _ = a.membership(context.Background(), "", "")
	a.membershipMu.Lock()
	defer a.membershipMu.Unlock()
	return len(a.memberships) > 0 && !a.membershipStale
}

func (a *notificationAPI) verify(r *http.Request) (apiPrincipal, int, error) {
	var p apiPrincipal
	if !a.configured() {
		return p, http.StatusServiceUnavailable, errors.New("owner_read_not_configured")
	}
	header := r.Header.Get("Authorization")
	if len(header) > 16<<10 || !strings.HasPrefix(header, "Bearer ") {
		return p, http.StatusUnauthorized, errors.New("invalid_token")
	}
	parts := strings.Split(strings.TrimPrefix(header, "Bearer "), ".")
	if len(parts) != 3 {
		return p, http.StatusUnauthorized, errors.New("invalid_token")
	}
	decode := func(s string, dst any) error {
		b, err := base64.RawURLEncoding.DecodeString(s)
		if err != nil {
			return err
		}
		return json.Unmarshal(b, dst)
	}
	var h jwtHeader
	if decode(parts[0], &h) != nil || h.Alg != "RS256" || h.Kid == "" {
		return p, http.StatusUnauthorized, errors.New("invalid_token")
	}
	key, err := a.key(r.Context(), h.Kid)
	if err != nil {
		return p, http.StatusServiceUnavailable, errors.New("auth_unavailable")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return p, http.StatusUnauthorized, errors.New("invalid_token")
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig) != nil {
		return p, http.StatusUnauthorized, errors.New("invalid_token")
	}
	var c jwtClaims
	now := time.Now().Unix()
	if decode(parts[1], &c) != nil || c.Iss != a.issuer || c.Sub == "" || c.Exp <= now || c.Nbf > now+30 {
		return p, http.StatusUnauthorized, errors.New("invalid_claims")
	}
	var aud string
	if json.Unmarshal(c.Aud, &aud) == nil {
		if aud != a.audience {
			return p, http.StatusUnauthorized, errors.New("invalid_claims")
		}
	} else {
		var audiences []string
		if json.Unmarshal(c.Aud, &audiences) != nil || !hasValue(audiences, a.audience) {
			return p, http.StatusUnauthorized, errors.New("invalid_claims")
		}
	}
	membership, found, membershipErr := a.membership(r.Context(), c.Iss, c.Sub)
	if membershipErr != nil {
		return p, http.StatusServiceUnavailable, errors.New("auth_unavailable")
	}
	if !found {
		return p, http.StatusUnauthorized, errors.New("invalid_claims")
	}
	for _, role := range membership.Roles {
		if role != "viewer" && role != "operator" && role != "admin" && role != "device" {
			return p, http.StatusUnauthorized, errors.New("invalid_claims")
		}
	}
	if !hasValue(membership.Roles, "operator") && !hasValue(membership.Roles, "admin") {
		return p, http.StatusForbidden, errors.New("insufficient_role")
	}
	return apiPrincipal{Tenant: membership.Tenant, Subject: c.Sub, Roles: membership.Roles}, 0, nil
}

func hasValue(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}

func (a *notificationAPI) key(parent context.Context, kid string) (*rsa.PublicKey, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	if key := a.keys[kid]; key != nil {
		if now.Before(a.keysUntil) {
			return key, nil
		}
		// A short stale-key grace keeps valid traffic available during a failed refresh.
		if now.Sub(a.keysFetchedAt) < 30*time.Second {
			return key, nil
		}
	}
	// Allow issuer key rotation, while throttling attacker-controlled unknown kids.
	if now.Sub(a.keysFetchedAt) < 30*time.Second {
		return nil, errors.New("key not found")
	}
	u, err := url.Parse(a.jwksURL)
	if err != nil || (u.Scheme != "https" && u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
		return nil, errors.New("invalid jwks url")
	}
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	a.keysFetchedAt = time.Now()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, a.jwksURL, nil)
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jwks status %d", resp.StatusCode)
	}
	var doc jwksDocument
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&doc) != nil {
		return nil, errors.New("invalid jwks")
	}
	keys := make(map[string]*rsa.PublicKey)
	for _, item := range doc.Keys {
		if len(keys) >= 100 {
			break
		}
		if item.Kty != "RSA" || (item.Use != "" && item.Use != "sig") || item.Kid == "" {
			continue
		}
		n, er := base64.RawURLEncoding.DecodeString(item.N)
		if er != nil {
			continue
		}
		eb, er := base64.RawURLEncoding.DecodeString(item.E)
		if er != nil || len(eb) == 0 || len(eb) > 4 {
			continue
		}
		exponent := 0
		for _, b := range eb {
			exponent = exponent*256 + int(b)
		}
		if exponent < 3 || exponent%2 == 0 || len(n) < 256 || len(n) > 1024 {
			continue
		}
		keys[item.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: exponent}
	}
	a.keys, a.keysUntil = keys, time.Now().Add(5*time.Minute)
	if keys[kid] == nil {
		return nil, errors.New("key not found")
	}
	return keys[kid], nil
}

type catalogReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (a *notificationAPI) readinessHandler(db any) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.configured() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"status":"not_configured"}`))
			return
		}
		reader, ok := db.(catalogReader)
		if !ok {
			http.Error(w, `{"status":"unavailable"}`, http.StatusServiceUnavailable)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		var roleOK, rlsOK, policyOK bool
		err := reader.QueryRow(ctx, `SELECT current_user='jobs_app' AND NOT r.rolsuper AND NOT r.rolbypassrls
			AND NOT EXISTS (SELECT 1 FROM pg_roles elevated WHERE elevated.rolbypassrls
				AND pg_has_role(current_user, elevated.oid, 'USAGE'))
			FROM pg_roles r WHERE r.rolname=current_user`).Scan(&roleOK)
		if err == nil {
			err = reader.QueryRow(ctx, `SELECT c.relrowsecurity AND c.relforcerowsecurity,
				p.qual LIKE '%app.tenant_id%'
				FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
				JOIN pg_policies p ON p.schemaname=n.nspname AND p.tablename=c.relname AND p.policyname='tenant_isolation'
				WHERE n.nspname=current_schema() AND c.relname='notification_intents'`).Scan(&rlsOK, &policyOK)
		}
		if err != nil || !roleOK || !rlsOK || !policyOK {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"status":"unavailable"}`))
			return
		}
		_, _ = w.Write([]byte("ready\n"))
	}
}

type intentCursor struct{ Tenant, Alert, Version, Channel, Intent string }

func (a *notificationAPI) encodeCursor(c intentCursor) string {
	b, _ := json.Marshal(c)
	payload := base64.RawURLEncoding.EncodeToString(b)
	mac := hmacSHA256([]byte(a.cursorKey), []byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac)
}
func (a *notificationAPI) decodeCursor(raw, tenant, alert string) (intentCursor, error) {
	var c intentCursor
	parts := strings.Split(raw, ".")
	if len(parts) != 2 {
		return c, errors.New("invalid cursor")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return c, err
	}
	want := hmacSHA256([]byte(a.cursorKey), []byte(parts[0]))
	if len(sig) != len(want) || subtle.ConstantTimeCompare(sig, want) != 1 {
		return c, errors.New("invalid cursor")
	}
	b, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(b, &c) != nil || c.Tenant != tenant || c.Alert != alert || c.Version == "" || c.Channel == "" || !uuidPattern.MatchString(c.Intent) {
		return c, errors.New("invalid cursor")
	}
	return c, nil
}

func (a *notificationAPI) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		if r.Method != http.MethodGet || r.URL.Path != "/internal/v1/notification-intents" {
			http.NotFound(w, r)
			return
		}
		p, status, err := a.verify(r)
		if err != nil {
			http.Error(w, err.Error(), status)
			return
		}
		q := r.URL.Query()
		alert := q.Get("alertId")
		if !uuidPattern.MatchString(alert) {
			http.Error(w, "invalid_alert_id", 400)
			return
		}
		limit := 50
		if raw := q.Get("limit"); raw != "" {
			var n int
			if _, err := fmt.Sscan(raw, &n); err != nil || n < 1 || n > 100 {
				http.Error(w, "invalid_limit", 400)
				return
			}
			limit = n
		}
		var after intentCursor
		if raw := q.Get("after"); raw != "" {
			var err error
			after, err = a.decodeCursor(raw, p.Tenant, alert)
			if err != nil {
				http.Error(w, "invalid_cursor", 400)
				return
			}
		}
		items := make([]map[string]any, 0, limit+1)
		err = WithTenant(r.Context(), a.db, p.Tenant, func(ctx context.Context, tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `SET LOCAL statement_timeout = '3000ms'`); err != nil {
				return err
			}
			var rows pgx.Rows
			var err error
			if after.Intent == "" {
				rows, err = tx.Query(ctx, `SELECT intent_id::text, transition_version::text, transition, severity, channel, status, redrive_count, attempts, created_at, first_attempt_at, last_attempt_at, dead_at FROM notification_intents WHERE tenant_id=$1 AND alert_id=$2 AND severity='warning' ORDER BY transition_version,channel,intent_id LIMIT $3`, p.Tenant, alert, limit+1)
			} else {
				rows, err = tx.Query(ctx, `SELECT intent_id::text, transition_version::text, transition, severity, channel, status, redrive_count, attempts, created_at, first_attempt_at, last_attempt_at, dead_at FROM notification_intents WHERE tenant_id=$1 AND alert_id=$2 AND severity='warning' AND (transition_version,channel,intent_id) > ($3::bigint,$4,$5::uuid) ORDER BY transition_version,channel,intent_id LIMIT $6`, p.Tenant, alert, after.Version, after.Channel, after.Intent, limit+1)
			}
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var id, ver, transition, severity, channel, state string
				var gen, attempts int
				var created time.Time
				var first, last, dead *time.Time
				if err := rows.Scan(&id, &ver, &transition, &severity, &channel, &state, &gen, &attempts, &created, &first, &last, &dead); err != nil {
					return err
				}
				reason := ""
				if state == "dead" {
					reason = "retries_exhausted"
				}
				items = append(items, map[string]any{"intentId": id, "transitionVersion": ver, "transition": transition, "severity": severity, "channel": channel, "state": state, "deliveryGeneration": gen, "dispatchAttempts": attempts, "queuedAt": created.UTC().Format(time.RFC3339Nano), "firstAttemptAt": formatTime(first), "lastAttemptAt": formatTime(last), "resolvedAt": formatTime(dead), "reasonCode": reason})
			}
			return rows.Err()
		})
		if err != nil {
			http.Error(w, "owner_read_failed", 503)
			return
		}
		audit := hmacSHA256([]byte(a.cursorKey), []byte("notification-read-v1\x00"+p.Tenant+"\x00"+p.Subject))
		slog.Info("notification history read", "audit_id", hex.EncodeToString(audit[:12]), "result_count", len(items))
		var next any
		if len(items) > limit {
			last := items[limit-1]
			next = a.encodeCursor(intentCursor{Tenant: p.Tenant, Alert: alert, Version: last["transitionVersion"].(string), Channel: last["channel"].(string), Intent: last["intentId"].(string)})
			items = items[:limit]
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"items": items, "nextCursor": next})
	})
}

func formatTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339Nano)
}

func hmacSHA256(key, message []byte) []byte {
	h := hmac.New(sha256.New, key)
	_, _ = h.Write(message)
	return h.Sum(nil)
}
