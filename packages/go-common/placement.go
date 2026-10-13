package common

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5/pgconn"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

var ErrPlacementUnavailable = errors.New("tenant placement unavailable")

// ErrTenantPlacementNotFound represents an authenticated 404 from the
// authoritative placement service. It is distinct from outages and auth
// failures so event consumers can preserve unroutable records in quarantine.
var ErrTenantPlacementNotFound = errors.New("tenant placement not found")
var ErrTenantQuiescing = errors.New("tenant placement is not active")
var ErrTenantAdmissionRejected = errors.New("durable tenant placement admission rejected")

type PlacementResolver interface {
	Resolve(context.Context, string) (TenantPlacement, error)
}

type placementEntry struct {
	route TenantPlacement
	until time.Time
}

// HTTPPlacementResolver accepts only authenticated authority responses. Its
// one-second cache never extends the authority expiry or serves during outage.
type HTTPPlacementResolver struct {
	endpoint *url.URL
	token    string
	client   *http.Client
	mu       sync.Mutex
	entries  map[string]placementEntry
}

func NewHTTPPlacementResolver(base, token string, meshMTLS bool) (*HTTPPlacementResolver, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || token == "" ||
		(u.Scheme != "https" && (u.Scheme != "http" || (!loopbackHost(u.Hostname()) && !(meshMTLS && InternalMeshHost(u.Hostname()))))) {
		return nil, ErrPlacementUnavailable
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/"
	u.RawQuery, u.Fragment = "", ""
	return &HTTPPlacementResolver{endpoint: u, token: token, entries: make(map[string]placementEntry),
		client: &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func loopbackHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// InternalMeshHost admits only explicit private addresses or internal service
// DNS names when the deployment declares authenticated mesh transport.
func InternalMeshHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsPrivate() || ip.IsLoopback()
	}
	if strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".svc") || strings.HasSuffix(host, ".svc.cluster.local") {
		return true
	}
	return len(host) > 0 && !strings.Contains(host, ".") && !strings.ContainsAny(host, "/:@ ")
}

func (r *HTTPPlacementResolver) Resolve(ctx context.Context, tenant string) (TenantPlacement, error) {
	if !TenantPattern.MatchString(tenant) {
		return TenantPlacement{}, ErrInvalidTenant
	}
	now := time.Now()
	r.mu.Lock()
	entry, ok := r.entries[tenant]
	r.mu.Unlock()
	if ok && now.Before(entry.until) && now.Before(entry.route.ExpiresAt) {
		if entry.route.State != "active" {
			return TenantPlacement{}, ErrTenantQuiescing
		}
		return entry.route, nil
	}
	u := *r.endpoint
	u.Path += "v1/internal/placements/" + tenant
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return TenantPlacement{}, ErrPlacementUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	response, err := r.client.Do(req)
	if err != nil {
		r.Invalidate(tenant)
		return TenantPlacement{}, ErrPlacementUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		r.Invalidate(tenant)
		if response.StatusCode == http.StatusNotFound {
			return TenantPlacement{}, ErrTenantPlacementNotFound
		}
		return TenantPlacement{}, ErrPlacementUnavailable
	}
	var body struct {
		TenantID    string    `json:"tenantId"`
		ShardID     string    `json:"shardId"`
		Incarnation string    `json:"shardIncarnation"`
		Epoch       string    `json:"placementEpoch"`
		State       string    `json:"state"`
		ExpiresAt   time.Time `json:"expiresAt"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 8193))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		r.Invalidate(tenant)
		return TenantPlacement{}, ErrPlacementUnavailable
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		r.Invalidate(tenant)
		return TenantPlacement{}, ErrPlacementUnavailable
	}
	now = time.Now()
	epoch, err := strconv.ParseInt(body.Epoch, 10, 64)
	if body.TenantID != tenant || !ShardPattern.MatchString(body.ShardID) || !TenantPattern.MatchString(body.Incarnation) ||
		!decimalEpochPattern.MatchString(body.Epoch) || err != nil || epoch <= 0 || !now.Before(body.ExpiresAt) || body.ExpiresAt.Sub(now) > 2*time.Second ||
		(body.State != "active" && body.State != "quiescing" && body.State != "activating") {
		r.Invalidate(tenant)
		return TenantPlacement{}, ErrPlacementUnavailable
	}
	route := TenantPlacement{TenantID: tenant, ShardID: body.ShardID, Incarnation: body.Incarnation, PlacementEpoch: body.Epoch, State: body.State, ExpiresAt: body.ExpiresAt}
	r.mu.Lock()
	if prior, exists := r.entries[tenant]; exists && now.Before(prior.route.ExpiresAt) {
		previous, _ := strconv.ParseInt(prior.route.PlacementEpoch, 10, 64)
		if epoch < previous || (epoch == previous && (route.ShardID != prior.route.ShardID || route.Incarnation != prior.route.Incarnation)) {
			delete(r.entries, tenant)
			r.mu.Unlock()
			return TenantPlacement{}, ErrPlacementUnavailable
		}
	}
	if len(r.entries) >= 4096 {
		for key, entry := range r.entries {
			if !now.Before(entry.route.ExpiresAt) {
				delete(r.entries, key)
			}
		}
	}
	// Keep still-valid identity floors. A full cache can return the fresh
	// authoritative route without retaining another entry or evicting its peers.
	if _, exists := r.entries[tenant]; exists || len(r.entries) < 4096 {
		r.entries[tenant] = placementEntry{route: route, until: minTimePlacement(now.Add(time.Second), route.ExpiresAt)}
	}
	r.mu.Unlock()
	if route.State != "active" {
		return TenantPlacement{}, ErrTenantQuiescing
	}
	return route, nil
}

func minTimePlacement(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
func (r *HTTPPlacementResolver) Invalidate(tenant string) {
	r.mu.Lock()
	delete(r.entries, tenant)
	r.mu.Unlock()
}

// IsPlacementPaused distinguishes repairable ownership admission from poison
// data. Event offsets/work receipts must remain uncommitted during a pause.
func IsPlacementPaused(err error) bool {
	return errors.Is(err, ErrTenantQuiescing) || errors.Is(err, ErrPlacementUnavailable) || errors.Is(err, ErrTenantPlacementNotFound) || errors.Is(err, ErrInvalidTenantPlacement) || ownershipAdmissionRejected(err)
}

func ownershipAdmissionRejected(err error) bool {
	if errors.Is(err, ErrTenantAdmissionRejected) {
		return true
	}
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "42501"
}
