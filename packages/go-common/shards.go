package common

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const InfrastructureTenant = "00000000-0000-4000-8000-000000000001"

var ErrShardRegistry = errors.New("invalid private shard registry")
var ErrShardRegistryRequired = errors.New("private shard registry is required")
var ErrUnscopedShardTransaction = errors.New("sharded database requires tenant placement or an explicit shard")
var projectionSchema = regexp.MustCompile(`^read_v[1-9][0-9]{0,8}$`)

type ShardEndpoint struct {
	Incarnation string   `json:"incarnation"`
	PrimaryURL  string   `json:"primaryUrl"`
	ReplicaURLs []string `json:"replicaUrls"`
}
type ShardRegistry struct {
	FormatVersion int                      `json:"formatVersion"`
	Service       string                   `json:"service"`
	Database      string                   `json:"database"`
	Shards        map[string]ShardEndpoint `json:"shards"`
}

func LoadShardRegistry(path, service, database, role string) (ShardRegistry, error) {
	var registry ShardRegistry
	f, err := os.Open(path)
	if err != nil {
		return registry, ErrShardRegistry
	}
	defer f.Close()
	info, err := f.Stat()
	// Kubernetes Secret projections mounted into non-root workloads need group
	// read when fsGroup is used. Permit 0400/0440 only; reject group write/exec
	// and every world permission so credentials remain private to the pod group.
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0037 != 0 || info.Size() > 65536 {
		return registry, ErrShardRegistry
	}
	body, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil {
		return registry, ErrShardRegistry
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.DisallowUnknownFields()
	if d.Decode(&registry) != nil {
		return registry, ErrShardRegistry
	}
	if err := d.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return registry, ErrShardRegistry
	}
	if registry.FormatVersion != 1 || registry.Service != service || registry.Database != database || len(registry.Shards) != 4 {
		return registry, ErrShardRegistry
	}
	addresses := make(map[string]bool)
	for _, id := range []string{"s1", "s2", "s3", "s4"} {
		endpoint, exists := registry.Shards[id]
		if !exists || !TenantPattern.MatchString(endpoint.Incarnation) || endpoint.ReplicaURLs == nil || len(endpoint.ReplicaURLs) > 8 {
			return registry, ErrShardRegistry
		}
		for _, raw := range append([]string{endpoint.PrimaryURL}, endpoint.ReplicaURLs...) {
			u, err := url.Parse(raw)
			if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.User == nil || u.User.Username() != role || u.Hostname() == "" || strings.Contains(u.Hostname(), ",") || u.Path != "/"+database || u.Fragment != "" {
				return registry, ErrShardRegistry
			}
			query, err := url.ParseQuery(u.RawQuery)
			if err != nil {
				return registry, ErrShardRegistry
			}
			for key, values := range query {
				if len(values) != 1 {
					return registry, ErrShardRegistry
				}
				switch key {
				case "sslmode", "sslrootcert", "sslcert", "sslkey", "connect_timeout", "application_name":
				default:
					return registry, ErrShardRegistry
				}
			}
			cfg, err := pgxpool.ParseConfig(raw)
			if err != nil || cfg.ConnConfig.Database != database || cfg.ConnConfig.User != role || cfg.ConnConfig.Host == "" {
				return registry, ErrShardRegistry
			}
			host := strings.TrimSuffix(strings.ToLower(cfg.ConnConfig.Host), ".")
			if ip := net.ParseIP(host); ip != nil {
				host = ip.String()
			}
			address := net.JoinHostPort(host, fmt.Sprint(cfg.ConnConfig.Port)) + "/" + database
			if addresses[address] {
				return registry, ErrShardRegistry
			}
			addresses[address] = true
			if !loopbackHost(cfg.ConnConfig.Host) && (cfg.ConnConfig.TLSConfig == nil || cfg.ConnConfig.TLSConfig.InsecureSkipVerify || len(cfg.ConnConfig.Fallbacks) > 0) {
				return registry, ErrShardRegistry
			}
		}
	}
	return registry, nil
}

// TenantTransactionRouter allows existing tenant transaction signatures to
// dispatch before BEGIN. BeginTx on ShardedDB itself always rejects ambiguity.
type TenantTransactionRouter interface {
	WithTenantSchema(context.Context, string, string, func(context.Context, pgx.Tx) error) error
}

type ShardedDB struct {
	registry     ShardRegistry
	resolver     PlacementResolver
	activeShards []string
	mu           sync.Mutex
	pools        map[string]*pgxpool.Pool
	closed       bool
}

func NewShardedDB(registry ShardRegistry, resolver PlacementResolver) *ShardedDB {
	return &ShardedDB{registry: registry, resolver: resolver, activeShards: []string{"s1", "s2", "s3", "s4"}, pools: make(map[string]*pgxpool.Pool)}
}

// ActiveShardIDs returns the shard set this process is configured to serve.
// Production defaults to all registered shards; local fixtures can opt into a
// loopback-only subset when other registry entries are placeholders.
func (s *ShardedDB) ActiveShardIDs() []string {
	return append([]string(nil), s.activeShards...)
}

func ShardedDBFromEnvironment(getenv func(string) string, service, database, role string) (*ShardedDB, error) {
	registry, err := LoadShardRegistry(getenv("SHARD_REGISTRY_FILE"), service, database, role)
	if err != nil {
		return nil, err
	}
	activeShards, err := configuredActiveShards(getenv("SHARD_ACTIVE_IDS"), getenv("SHARD_LOCAL_LOOPBACK") == "true", registry)
	if err != nil {
		return nil, err
	}
	mesh := getenv("CONTROL_PLANE_MESH_MTLS")
	if mesh != "" && mesh != "true" && mesh != "false" {
		return nil, ErrPlacementUnavailable
	}
	resolver, err := NewHTTPPlacementResolver(getenv("CONTROL_PLANE_URL"), getenv("CONTROL_LOOKUP_TOKEN"), mesh == "true")
	if err != nil {
		return nil, err
	}
	db := NewShardedDB(registry, resolver)
	db.activeShards = activeShards
	return db, nil
}

func configuredActiveShards(raw string, localLoopback bool, registry ShardRegistry) ([]string, error) {
	all := []string{"s1", "s2", "s3", "s4"}
	if raw == "" {
		return all, nil
	}
	if !localLoopback {
		return nil, ErrShardRegistry
	}
	for _, endpoint := range registry.Shards {
		primary, err := url.Parse(endpoint.PrimaryURL)
		if err != nil || !loopbackHost(primary.Hostname()) {
			return nil, ErrShardRegistry
		}
	}
	seen := make(map[string]bool)
	active := make([]string, 0, 4)
	for _, id := range strings.Split(raw, ",") {
		id = strings.TrimSpace(id)
		if id != "s1" && id != "s2" && id != "s3" && id != "s4" || seen[id] {
			return nil, ErrShardRegistry
		}
		seen[id] = true
		active = append(active, id)
	}
	if len(active) == 0 || !seen["s1"] {
		return nil, ErrShardRegistry
	}
	return active, nil
}

// RequireShardRegistry prevents a production deployment from falling back to
// its legacy database URL when registry environment wiring is accidentally
// omitted. Local legacy mode remains available when the setting is absent or
// explicitly false.
func RequireShardRegistry(getenv func(string) string) error {
	raw := getenv("SHARD_ROUTING_REQUIRED")
	if raw != "" && raw != "true" && raw != "false" {
		return errors.New("SHARD_ROUTING_REQUIRED must be true or false")
	}
	if raw == "true" && strings.TrimSpace(getenv("SHARD_REGISTRY_FILE")) == "" {
		return ErrShardRegistryRequired
	}
	return nil
}

func (s *ShardedDB) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) {
	return nil, ErrUnscopedShardTransaction
}

func (s *ShardedDB) Primary(ctx context.Context, shard string) (*pgxpool.Pool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrPlacementUnavailable
	}
	if pool := s.pools[shard]; pool != nil {
		return pool, nil
	}
	endpoint, exists := s.registry.Shards[shard]
	if !exists {
		return nil, ErrInvalidTenantPlacement
	}
	cfg, err := pgxpool.ParseConfig(endpoint.PrimaryURL)
	if err != nil {
		return nil, ErrShardRegistry
	}
	cfg.MaxConns = 5
	cfg.MinConns = 0
	cfg.ConnConfig.ConnectTimeout = time.Second
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, ErrPlacementUnavailable
	}
	s.pools[shard] = pool
	return pool, nil
}

func (s *ShardedDB) WithTenantSchema(ctx context.Context, tenant, schema string, fn func(context.Context, pgx.Tx) error) error {
	if !TenantPattern.MatchString(tenant) {
		return ErrInvalidTenant
	}
	if schema != "" && schema != "public" && !projectionSchema.MatchString(schema) {
		return ErrInvalidTenantPlacement
	}
	route, err := s.resolver.Resolve(ctx, tenant)
	if err != nil {
		return err
	}
	endpoint, exists := s.registry.Shards[route.ShardID]
	if !exists || !s.isActiveShard(route.ShardID) || endpoint.Incarnation != route.Incarnation || route.TenantID != tenant {
		return ErrInvalidTenantPlacement
	}
	pool, err := s.Primary(ctx, route.ShardID)
	if err != nil {
		return err
	}
	err = WithTenantPlacement(ctx, pool, route, func(ctx context.Context, tx pgx.Tx) error {
		if schema != "" && schema != "public" {
			if _, err := tx.Exec(ctx, "SELECT set_config('search_path',$1,true)", schema+",pg_catalog"); err != nil {
				return err
			}
		}
		return fn(ctx, tx)
	})
	if ownershipAdmissionRejected(err) {
		if invalidator, ok := s.resolver.(interface{ Invalidate(string) }); ok {
			invalidator.Invalidate(tenant)
		}
	}
	return err
}

// Four sequential endpoints bound both fanout and aggregate connection budget.
// Callers use only explicit tenant-free health/ID-selector/infrastructure SQL.
func (s *ShardedDB) ForEachPrimary(ctx context.Context, fn func(string, *pgxpool.Pool) error) error {
	for _, id := range s.activeShards {
		pool, err := s.Primary(ctx, id)
		if err != nil {
			return err
		}
		if err := fn(id, pool); err != nil {
			return err
		}
	}
	return nil
}

func (s *ShardedDB) isActiveShard(id string) bool {
	for _, active := range s.activeShards {
		if id == active {
			return true
		}
	}
	return false
}
func (s *ShardedDB) Ping(ctx context.Context) error {
	return s.ForEachPrimary(ctx, func(shard string, _ *pgxpool.Pool) error {
		return s.WithInfrastructure(ctx, shard, "", func(context.Context, pgx.Tx) error { return nil })
	})
}
func (s *ShardedDB) Close() {
	s.mu.Lock()
	s.closed = true
	pools := s.pools
	s.pools = nil
	s.mu.Unlock()
	for _, pool := range pools {
		pool.Close()
	}
}
