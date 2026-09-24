package main

import (
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	RoleViewer   = "viewer"
	RoleOperator = "operator"
	RoleAdmin    = "admin"
	RoleDevice   = "device"
)

const (
	codeMissingToken    = "missing_token"
	codeMalformedHeader = "malformed_header"
	codeInvalidToken    = "invalid_token"
	codeExpiredToken    = "expired_token"
	codeInvalidClaims   = "invalid_claims"
	codeInsufficient    = "insufficient_role"
	codeUnavailable     = "auth_unavailable"
)

const (
	bearerPrefix       = "bearer "
	defaultCacheMaxAge = 10 * time.Minute
	defaultCooldown    = 30 * time.Second
	defaultJWKSTimeout = 5 * time.Second
	defaultTolerance   = 30 * time.Second
	defaultMaxStale    = time.Hour
	maxJWKSBytes       = 1 << 20
)

var knownRoles = map[string]bool{RoleViewer: true, RoleOperator: true, RoleAdmin: true, RoleDevice: true}

var (
	errKeyUnavailable = errors.New("signing keys unavailable")
	errUnknownKey     = errors.New("unknown signing key")
)

type AuthError struct {
	Status int
	Code   string
}

func (e *AuthError) Error() string { return e.Code }

type AuthConfig struct {
	Issuer, Audience, JWKSURL      string
	CacheMaxAge, Cooldown, Timeout time.Duration
	// MaxStale is how long past CacheMaxAge a cached key may still be used while the key server is
	// unreachable, so a short outage does not stop every device; a longer one fails closed.
	MaxStale       time.Duration
	ClockTolerance time.Duration
	Now            func() time.Time
	Keyfunc        jwt.Keyfunc
}

type Verifier struct {
	parser  *jwt.Parser
	keyfunc jwt.Keyfunc
}

func NewVerifier(cfg AuthConfig) (*Verifier, error) {
	if cfg.Issuer == "" || cfg.Audience == "" {
		return nil, errors.New("auth: issuer and audience are required")
	}
	keyfunc := cfg.Keyfunc
	if keyfunc == nil {
		cache, err := newJWKSCache(cfg)
		if err != nil {
			return nil, err
		}
		keyfunc = cache.keyfunc
	}
	tolerance := orDuration(cfg.ClockTolerance, defaultTolerance)
	opts := []jwt.ParserOption{
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(cfg.Issuer),
		jwt.WithAudience(cfg.Audience),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(tolerance),
	}
	if cfg.Now != nil {
		opts = append(opts, jwt.WithTimeFunc(cfg.Now))
	}
	return &Verifier{parser: jwt.NewParser(opts...), keyfunc: keyfunc}, nil
}

func (v *Verifier) Verify(authorizationHeader string) (Principal, error) {
	token, authErr := bearerToken(authorizationHeader)
	if authErr != nil {
		return Principal{}, authErr
	}
	claims := jwt.MapClaims{}
	if _, err := v.parser.ParseWithClaims(token, claims, v.keyfunc); err != nil {
		return Principal{}, classifyJWTError(err)
	}
	return principalFromClaims(claims)
}

func RequireRole(p Principal, allowed ...string) error {
	for _, role := range allowed {
		if p.HasRole(role) {
			return nil
		}
	}
	return &AuthError{Status: http.StatusForbidden, Code: codeInsufficient}
}

func orDuration(value, fallback time.Duration) time.Duration {
	if value == 0 {
		return fallback
	}
	return value
}

func bearerToken(header string) (string, *AuthError) {
	if header == "" {
		return "", &AuthError{Status: http.StatusUnauthorized, Code: codeMissingToken}
	}
	if len(header) <= len(bearerPrefix) || !strings.EqualFold(header[:len(bearerPrefix)], bearerPrefix) {
		return "", &AuthError{Status: http.StatusUnauthorized, Code: codeMalformedHeader}
	}
	token := header[len(bearerPrefix):]
	if strings.ContainsAny(token, " \t\r\n") {
		return "", &AuthError{Status: http.StatusUnauthorized, Code: codeMalformedHeader}
	}
	return token, nil
}

// Only the sentinel and the expiry are surfaced; library error text can echo token content.
func classifyJWTError(err error) *AuthError {
	switch {
	case errors.Is(err, errKeyUnavailable):
		return &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	case errors.Is(err, jwt.ErrTokenExpired):
		return &AuthError{Status: http.StatusUnauthorized, Code: codeExpiredToken}
	default:
		return &AuthError{Status: http.StatusUnauthorized, Code: codeInvalidToken}
	}
}

func principalFromClaims(claims jwt.MapClaims) (Principal, error) {
	sub, _ := claims["sub"].(string)
	tenant, _ := claims["tenant_id"].(string)
	roles, rolesOK := parseRoles(claims["roles"])
	if sub == "" || !isUUID(tenant) || !rolesOK {
		return Principal{}, &AuthError{Status: http.StatusUnauthorized, Code: codeInvalidClaims}
	}
	return Principal{Subject: sub, TenantID: tenant, Roles: roles}, nil
}

func parseRoles(raw any) ([]string, bool) {
	list, ok := raw.([]any)
	if !ok || len(list) == 0 {
		return nil, false
	}
	seen := make(map[string]bool, len(list))
	roles := make([]string, 0, len(list))
	for _, item := range list {
		role, isString := item.(string)
		if !isString || !knownRoles[role] {
			return nil, false
		}
		if !seen[role] {
			seen[role] = true
			roles = append(roles, role)
		}
	}
	return roles, true
}

type jwksCache struct {
	url           string
	client        *http.Client
	maxAge        time.Duration
	maxStale      time.Duration
	cooldown      time.Duration
	mu            sync.Mutex
	keys          map[string]*rsa.PublicKey
	fetchedAt     time.Time
	lastAttempt   time.Time
	refreshing    chan struct{}
	refreshFailed bool
}

func newJWKSCache(cfg AuthConfig) (*jwksCache, error) {
	u, err := url.Parse(cfg.JWKSURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("auth: invalid JWKS URL")
	}
	return &jwksCache{
		url: cfg.JWKSURL,
		client: &http.Client{
			Timeout:   orDuration(cfg.Timeout, defaultJWKSTimeout),
			Transport: &http.Transport{DisableKeepAlives: true},
		},
		maxAge:   orDuration(cfg.CacheMaxAge, defaultCacheMaxAge),
		maxStale: orDuration(cfg.MaxStale, defaultMaxStale),
		cooldown: orDuration(cfg.Cooldown, defaultCooldown),
	}, nil
}

func (c *jwksCache) keyfunc(token *jwt.Token) (any, error) {
	kid, _ := token.Header["kid"].(string)
	if kid == "" {
		return nil, errUnknownKey
	}
	return c.key(kid)
}

// A single caller fetches without holding mu. Cached readers continue immediately;
// callers without a usable key share the in-flight refresh.
func (c *jwksCache) key(kid string) (*rsa.PublicKey, error) {
	c.mu.Lock()
	now := time.Now()
	if k, ok := c.keys[kid]; ok && now.Sub(c.fetchedAt) < c.maxAge {
		c.mu.Unlock()
		return k, nil
	}
	if done := c.refreshing; done != nil {
		key, err := c.lookup(kid, now)
		c.mu.Unlock()
		if err == nil {
			return key, nil
		}
		<-done
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.lookup(kid, time.Now())
	}
	if !c.lastAttempt.IsZero() && now.Sub(c.lastAttempt) < c.cooldown {
		defer c.mu.Unlock()
		return c.lookup(kid, now)
	}
	c.lastAttempt = now
	c.refreshing = make(chan struct{})
	c.mu.Unlock()

	keys, err := c.fetch()

	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshFailed = err != nil
	if err == nil {
		c.keys, c.fetchedAt = keys, now
	}
	close(c.refreshing)
	c.refreshing = nil
	return c.lookup(kid, time.Now())
}

// lookup returns a cached key if it is fresh, or stale by no more than maxStale. Beyond that
// it fails closed, so a key revoked at the identity provider cannot be trusted indefinitely.
func (c *jwksCache) lookup(kid string, now time.Time) (*rsa.PublicKey, error) {
	if c.keys == nil {
		return nil, errKeyUnavailable
	}
	k, ok := c.keys[kid]
	if !ok {
		if c.refreshFailed {
			return nil, errKeyUnavailable
		}
		return nil, errUnknownKey
	}
	if now.Sub(c.fetchedAt) >= c.maxAge+c.maxStale {
		return nil, errKeyUnavailable
	}
	return k, nil
}

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

func (c *jwksCache) fetch() (map[string]*rsa.PublicKey, error) {
	resp, err := c.client.Get(c.url)
	if err != nil {
		return nil, errKeyUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errKeyUnavailable
	}
	var doc struct {
		Keys []jwk `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxJWKSBytes)).Decode(&doc); err != nil {
		return nil, errKeyUnavailable
	}
	keys := make(map[string]*rsa.PublicKey, len(doc.Keys))
	for _, k := range doc.Keys {
		if pub, ok := k.publicKey(); ok {
			keys[k.Kid] = pub
		}
	}
	return keys, nil
}

func (k jwk) publicKey() (*rsa.PublicKey, bool) {
	if k.Kty != "RSA" || k.Kid == "" {
		return nil, false
	}
	n, errN := base64.RawURLEncoding.DecodeString(k.N)
	e, errE := base64.RawURLEncoding.DecodeString(k.E)
	if errN != nil || errE != nil || len(n) == 0 || len(e) == 0 || len(e) > 4 {
		return nil, false
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}, true
}
