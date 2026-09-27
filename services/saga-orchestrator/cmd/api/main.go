package main

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
	"greenguard.local/saga-orchestrator/saga"
)

type principal struct {
	Tenant, Subject string
	Roles           map[string]bool
}
type verifier struct {
	issuer, audience, jwksURL string
	membershipFile            string
	membershipSource          string
	membershipCache           *controlMembershipCache
	client                    *http.Client
	mu                        sync.Mutex
	keys                      map[string]*rsa.PublicKey
	fetchedAt                 time.Time
	lastAttempt               time.Time
}
type server struct {
	store   saga.Store
	auth    *verifier
	metrics http.Handler
}

const (
	authMembershipFile          = "file"
	authMembershipControlPlane  = "control-plane"
	roleOperator                = "operator"
	roleAdmin                   = "admin"
	roleViewer                  = "viewer"
	problemInsufficientRoleCode = "insufficient_role"
	problemInvalidTokenCode     = "invalid_token"
	problemInvalidJSONCode      = "invalid_json"
	problemInvalidRolesCode     = "invalid roles"
	jwtAlgorithmRS256           = "RS256"
	jwtKeyIDHeader              = "kid"
	loopbackHostname            = "localhost"
	loopbackIP                  = "127.0.0.1"
	provisioningPath            = "/v1/provisioning"
	provisioningPathPrefix      = "/v1/provisioning/"
	authIssuerEnvironment       = "AUTH_ISSUER"
	authAudienceEnvironment     = "AUTH_AUDIENCE"
	authJWKSURLEnvironment      = "AUTH_JWKS_URL"
	contentTypeHeader           = "Content-Type"
	jsonMediaType               = "application/json"
)

func main() {
	ctx := context.Background()
	auth, err := newVerifierFromEnvironment()
	if err != nil {
		log.Fatal(err)
	}
	pool, err := openSagaPool(ctx, os.Getenv("SAGA_DIRECT_URL"))
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		log.Fatal(err)
	}
	if auth.membershipSource == authMembershipControlPlane {
		if err := initializeMembershipSource(auth, authMembershipControlPlane); err != nil {
			log.Fatal(err)
		}
	}
	if auth.membershipCache != nil {
		defer auth.membershipCache.close()
		if err := auth.membershipCache.startConsumer(ctx); err != nil {
			log.Fatal(err)
		}
	}
	s := server{store: saga.Store{DB: pool}, auth: auth, metrics: saga.Handler(nil, pool)}
	addr := os.Getenv("SAGA_API_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8092"
	}
	tlsConfig, err := apiTLSConfig(os.Getenv("SAGA_API_TLS_CERT_FILE"), os.Getenv("SAGA_API_TLS_KEY_FILE"), os.Getenv("SAGA_API_TLS_CLIENT_CA_FILE"))
	if err != nil {
		log.Fatal(err)
	}
	if err := validateListenAddress(addr, tlsConfig != nil); err != nil {
		log.Fatal(err)
	}
	httpServer := &http.Server{Addr: addr, Handler: &s, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second}
	httpServer.TLSConfig = tlsConfig
	runHTTPServer(httpServer)
}

func openSagaPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	if dsn == "" {
		return nil, errors.New("SAGA_DIRECT_URL is required")
	}
	return pgxpool.New(ctx, dsn)
}

func newVerifierFromEnvironment() (*verifier, error) {
	for _, key := range []string{authIssuerEnvironment, authAudienceEnvironment, authJWKSURLEnvironment} {
		if os.Getenv(key) == "" {
			return nil, fmt.Errorf("%s is required", key)
		}
	}
	jwksURL, err := validatedJWKSURL(os.Getenv(authJWKSURLEnvironment))
	if err != nil {
		return nil, err
	}
	source := os.Getenv("AUTH_MEMBERSHIP_SOURCE")
	if source == "" {
		source = authMembershipFile
	}
	if source != authMembershipFile && source != authMembershipControlPlane {
		return nil, errors.New("AUTH_MEMBERSHIP_SOURCE must be file or control-plane")
	}
	auth := &verifier{issuer: os.Getenv(authIssuerEnvironment), audience: os.Getenv(authAudienceEnvironment), jwksURL: jwksURL,
		membershipFile: os.Getenv("AUTH_MEMBERSHIP_FILE"), membershipSource: source, client: &http.Client{Timeout: 5 * time.Second}}
	if source == authMembershipFile {
		if err := validateMembershipFile(auth.membershipFile); err != nil {
			return nil, err
		}
	}
	return auth, nil
}

func initializeMembershipSource(auth *verifier, source string) error {
	if source != authMembershipControlPlane {
		return nil
	}
	cache, err := newControlMembershipCache(os.Getenv, auth.client)
	if err != nil {
		return err
	}
	auth.membershipCache = cache
	return nil
}

func validatedJWKSURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == loopbackHostname || u.Hostname() == loopbackIP))) {
		return "", errors.New("AUTH_JWKS_URL must be https or loopback http")
	}
	return u.String(), nil
}

func validateMembershipFile(path string) error {
	if path == "" {
		return nil
	}
	if _, err := loadMemberships(path); err != nil {
		return fmt.Errorf("invalid AUTH_MEMBERSHIP_FILE: %w", err)
	}
	return nil
}

func runHTTPServer(httpServer *http.Server) {
	stop, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-stop.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdown); err != nil {
			log.Printf("saga API shutdown: %v", err)
		}
	}()
	var serveErr error
	if httpServer.TLSConfig != nil {
		serveErr = httpServer.ListenAndServeTLS("", "")
	} else {
		serveErr = httpServer.ListenAndServe()
	}
	stopSignals()
	<-shutdownDone
	if err := serveErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func validateListenAddress(addr string, tlsEnabled bool) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid SAGA_API_ADDR: %w", err)
	}
	if tlsEnabled || strings.EqualFold(host, loopbackHostname) {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return errors.New("SAGA_API_ADDR must bind loopback unless mTLS is enabled")
	}
	return nil
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/healthz" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// Aggregate, tenant-free gauges only; the API binds loopback unless mTLS is on.
	if r.URL.Path == "/metrics" && s.metrics != nil {
		s.metrics.ServeHTTP(w, r)
		return
	}
	if r.URL.Path != provisioningPath && !strings.HasPrefix(r.URL.Path, provisioningPathPrefix) {
		http.NotFound(w, r)
		return
	}
	p, err := s.auth.verify(r)
	if err != nil {
		if errors.Is(err, errMembershipRevoked) {
			problem(w, http.StatusForbidden, problemInsufficientRoleCode)
			return
		}
		problem(w, http.StatusUnauthorized, problemInvalidTokenCode)
		return
	}
	s.route(w, r, p)
}

// hasAnyRole reports whether the principal holds at least one of roles.
func hasAnyRole(p principal, roles ...string) bool {
	for _, role := range roles {
		if p.Roles[role] {
			return true
		}
	}
	return false
}

// route dispatches an authenticated provisioning request after its role check.
func (s *server) route(w http.ResponseWriter, r *http.Request, p principal) {
	if r.URL.Path == provisioningPath && r.Method == http.MethodPost {
		if !hasAnyRole(p, roleOperator, roleAdmin) {
			problem(w, 403, problemInsufficientRoleCode)
			return
		}
		s.start(w, r, p)
		return
	}
	id, suffix := splitPath(strings.TrimPrefix(r.URL.Path, provisioningPathPrefix))
	if id == "" {
		http.NotFound(w, r)
		return
	}
	if suffix == "" && r.Method == http.MethodGet {
		if !hasAnyRole(p, roleViewer, roleOperator, roleAdmin) {
			problem(w, 403, problemInsufficientRoleCode)
			return
		}
		s.status(w, r, p, id)
		return
	}
	if suffix == "redrive" && r.Method == http.MethodPost {
		if !hasAnyRole(p, roleAdmin) {
			problem(w, 403, problemInsufficientRoleCode)
			return
		}
		s.redrive(w, r, p, id)
		return
	}
	http.NotFound(w, r)
}

func splitPath(path string) (string, string) {
	parts := strings.Split(path, "/")
	if len(parts) == 1 {
		return parts[0], ""
	}
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return "", ""
}

func (s *server) start(w http.ResponseWriter, r *http.Request, p principal) {
	var body struct {
		DeviceID string `json:"device_id"`
		AssetID  string `json:"asset_id"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	key := r.Header.Get("Idempotency-Key")
	snap, err := s.store.Start(r.Context(), saga.StartRequest{TenantID: p.Tenant, IdempotencyKey: key, DeviceID: body.DeviceID, AssetID: body.AssetID,
		Traceparent: r.Header.Get("traceparent")})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, 202, snap)
}

func (s *server) status(w http.ResponseWriter, r *http.Request, p principal, id string) {
	snap, audit, err := s.store.Status(r.Context(), p.Tenant, id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, 200, struct {
		Saga    saga.Snapshot     `json:"saga"`
		History []saga.AuditEntry `json:"history"`
	}{snap, audit})
}

func (s *server) redrive(w http.ResponseWriter, r *http.Request, p principal, id string) {
	var body struct {
		Reason string `json:"reason"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	snap, err := s.store.Redrive(r.Context(), saga.RedriveRequest{TenantID: p.Tenant, SagaID: id, ActorSub: p.Subject, Reason: body.Reason})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, 202, snap)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if !strings.HasPrefix(r.Header.Get(contentTypeHeader), jsonMediaType) {
		problem(w, 415, "unsupported_media_type")
		return false
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<16))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		problem(w, 400, problemInvalidJSONCode)
		return false
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		problem(w, 400, problemInvalidJSONCode)
		return false
	}
	return true
}

func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, saga.ErrInvalidRequest):
		problem(w, 400, "invalid_request")
	case errors.Is(err, saga.ErrSagaNotFound):
		problem(w, 404, "not_found")
	case errors.Is(err, saga.ErrAssetClaimed), errors.Is(err, saga.ErrIdempotencyConflict), errors.Is(err, saga.ErrRepairState):
		problem(w, 409, "conflict")
	default:
		problem(w, 500, "internal_error")
	}
}

func problem(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]any{"code": code})
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set(contentTypeHeader, jsonMediaType)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (v *verifier) verify(r *http.Request) (principal, error) {
	const bearerPrefix = "Bearer "
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, bearerPrefix) || strings.ContainsAny(strings.TrimPrefix(header, bearerPrefix), " \t\r\n") {
		return principal{}, errors.New("invalid bearer")
	}
	claims := jwt.MapClaims{}
	parser := jwt.NewParser(jwt.WithValidMethods([]string{jwtAlgorithmRS256}), jwt.WithIssuer(v.issuer), jwt.WithAudience(v.audience), jwt.WithExpirationRequired())
	_, err := parser.ParseWithClaims(strings.TrimPrefix(header, bearerPrefix), claims, v.key)
	if err != nil {
		return principal{}, err
	}
	sub, _ := claims["sub"].(string)
	tenant, _ := claims["tenant_id"].(string)
	var roles map[string]bool
	if v.membershipSource == authMembershipControlPlane {
		tenant, roles, err = v.membershipCache.roles(r.Context(), v.issuer, sub)
	} else if v.membershipFile != "" {
		// The IdP proves identity only. GreenGuard's current membership overrides
		// any tenant or role claims the token carries, even if they are signed.
		tenant, roles, err = v.membershipRoles(sub)
	} else {
		roles, err = claimRoles(claims)
	}
	if err != nil {
		return principal{}, err
	}
	if !common.TenantPattern.MatchString(tenant) || sub == "" {
		return principal{}, errors.New("missing principal")
	}
	if len(roles) == 0 {
		return principal{}, errors.New(problemInvalidRolesCode)
	}
	return principal{Tenant: tenant, Subject: sub, Roles: roles}, nil
}

func (v *verifier) membershipRoles(sub string) (string, map[string]bool, error) {
	membership, err := membershipFor(v.membershipFile, v.issuer, sub)
	if err != nil {
		return "", nil, err
	}
	roles := map[string]bool{}
	for _, role := range membership.Roles {
		roles[role] = true
	}
	return membership.TenantID, roles, nil
}

func claimRoles(claims jwt.MapClaims) (map[string]bool, error) {
	items, ok := claims["roles"].([]any)
	if !ok {
		return nil, errors.New("missing roles")
	}
	roles := map[string]bool{}
	for _, item := range items {
		role, ok := item.(string)
		if !ok || !validRole(role) {
			return nil, errors.New(problemInvalidRolesCode)
		}
		roles[role] = true
	}
	return roles, nil
}

type jwk struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// parseRSAKey returns nil, nil for keys that are not RS256 signing keys.
func parseRSAKey(item jwk) (*rsa.PublicKey, error) {
	if item.Kid == "" || item.Kty != "RSA" || item.Alg != jwtAlgorithmRS256 || item.Use != "sig" {
		return nil, nil
	}
	n, err := base64.RawURLEncoding.DecodeString(item.N)
	if err != nil {
		return nil, err
	}
	e, err := base64.RawURLEncoding.DecodeString(item.E)
	if err != nil {
		return nil, err
	}
	if len(n) < 256 || len(e) == 0 || len(e) > 4 {
		return nil, errors.New("invalid RSA key")
	}
	exp := 0
	for _, b := range e {
		exp = exp<<8 | int(b)
	}
	if exp < 3 || exp%2 == 0 {
		return nil, errors.New("invalid RSA exponent")
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: exp}, nil
}

func (v *verifier) key(token *jwt.Token) (any, error) {
	kid, _ := token.Header[jwtKeyIDHeader].(string)
	if kid == "" {
		return nil, errors.New("missing kid")
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if key := v.keys[kid]; key != nil && time.Since(v.fetchedAt) < 10*time.Minute {
		return key, nil
	}
	if time.Since(v.lastAttempt) < 10*time.Second {
		return nil, errors.New("unknown or expired signing key")
	}
	v.lastAttempt = time.Now()
	resp, err := v.client.Get(v.jwksURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, errors.New("jwks unavailable")
	}
	var doc struct {
		Keys []jwk `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&doc); err != nil {
		return nil, err
	}
	keys := make(map[string]*rsa.PublicKey)
	for _, item := range doc.Keys {
		key, err := parseRSAKey(item)
		if err != nil {
			return nil, err
		}
		if key != nil {
			keys[item.Kid] = key
		}
	}
	v.keys = keys
	v.fetchedAt = time.Now()
	if key := keys[kid]; key != nil {
		return key, nil
	}
	return nil, errors.New("unknown key")
}
