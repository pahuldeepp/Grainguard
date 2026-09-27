package history

import (
	"context"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

// Config selects the cluster, keyspace and replication for one environment.
type Config struct {
	Hosts             []string
	Keyspace          string
	Datacenter        string
	ReplicationFactor int
	MetadataCacheMode gocql.MetadataCacheMode
	Username          string
	Password          string
	Timeout           time.Duration
}

var identifier = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)

// LoadConfig reads CASSANDRA_* settings. The local profile defaults to RF1,
// which is not highly available; the resilient profile sets RF3.
func LoadConfig(getenv func(string) string) (Config, error) {
	cfg := Config{Keyspace: getenv("CASSANDRA_KEYSPACE"), Datacenter: getenv("CASSANDRA_DATACENTER"), ReplicationFactor: 1, Username: getenv("CASSANDRA_USERNAME"), Password: getenv("CASSANDRA_PASSWORD"), Timeout: 5 * time.Second}
	for _, host := range strings.Split(getenv("CASSANDRA_HOSTS"), ",") {
		if host = strings.TrimSpace(host); host != "" {
			cfg.Hosts = append(cfg.Hosts, host)
		}
	}
	if len(cfg.Hosts) == 0 {
		return cfg, errors.New("CASSANDRA_HOSTS is required")
	}
	if cfg.Keyspace == "" {
		cfg.Keyspace = "greenguard_history"
	}
	if cfg.Datacenter == "" {
		cfg.Datacenter = "datacenter1"
	}
	if !identifier.MatchString(cfg.Keyspace) || !identifier.MatchString(strings.ToLower(cfg.Datacenter)) {
		return cfg, errors.New("CASSANDRA_KEYSPACE and CASSANDRA_DATACENTER must be simple identifiers")
	}
	if rf := getenv("CASSANDRA_REPLICATION_FACTOR"); rf != "" {
		n, err := strconv.Atoi(rf)
		if err != nil || n < 1 || n > 5 {
			return cfg, errors.New("CASSANDRA_REPLICATION_FACTOR must be between 1 and 5")
		}
		cfg.ReplicationFactor = n
	}
	return cfg, nil
}

// Cluster builds a driver configuration with a datacenter-aware policy.
func (c Config) Cluster(keyspace string) *gocql.ClusterConfig {
	cluster := gocql.NewCluster(c.Hosts...)
	cluster.Keyspace = keyspace
	cluster.Consistency = gocql.LocalQuorum
	cluster.Timeout = c.Timeout
	cluster.ConnectTimeout = c.Timeout
	cluster.Metadata.CacheMode = c.MetadataCacheMode
	cluster.PoolConfig.HostSelectionPolicy = gocql.TokenAwareHostPolicy(gocql.DCAwareRoundRobinPolicy(c.Datacenter))
	if c.Username != "" {
		cluster.Authenticator = gocql.PasswordAuthenticator{Username: c.Username, Password: c.Password}
	}
	return cluster
}

// Open connects to the history keyspace.
func Open(c Config) (*CQLSession, error) {
	session, err := c.Cluster(c.Keyspace).CreateSession()
	if err != nil {
		return nil, fmt.Errorf("connect cassandra: %w", err)
	}
	return &CQLSession{session: session}, nil
}

// CQLSession adapts *gocql.Session to Session. Every statement is an
// idempotent upsert or read, so driver retries are safe.
type CQLSession struct{ session *gocql.Session }

func level(Consistency) gocql.Consistency { return gocql.LocalQuorum }

func (s *CQLSession) Exec(ctx context.Context, c Consistency, stmt string, args ...any) error {
	return s.session.Query(stmt, args...).Consistency(level(c)).Idempotent(true).ExecContext(ctx)
}

func (s *CQLSession) Iter(ctx context.Context, c Consistency, stmt string, args ...any) Rows {
	return s.session.Query(stmt, args...).Consistency(level(c)).Idempotent(true).PageSize(500).IterContext(ctx)
}

// Ping runs a cheap local read to prove the session can reach a coordinator.
func (s *CQLSession) Ping(ctx context.Context) error {
	return s.session.Query("SELECT release_version FROM system.local").Consistency(gocql.One).ExecContext(ctx)
}

func (s *CQLSession) Close() { s.session.Close() }

// Transient reports driver and server failures worth retrying: unavailable,
// timeouts, overload, bootstrapping and connection loss.
func Transient(err error) bool {
	var unavailable *gocql.RequestErrUnavailable
	var writeTimeout *gocql.RequestErrWriteTimeout
	var readTimeout *gocql.RequestErrReadTimeout
	var netErr net.Error
	if errors.As(err, &unavailable) || errors.As(err, &writeTimeout) || errors.As(err, &readTimeout) || errors.As(err, &netErr) {
		return true
	}
	if errors.Is(err, ErrNotConnected) || errors.Is(err, gocql.ErrSessionClosed) || errors.Is(err, gocql.ErrNoConnectionsStarted) {
		return true
	}
	if errors.Is(err, gocql.ErrNoConnections) || errors.Is(err, gocql.ErrTimeoutNoResponse) || errors.Is(err, gocql.ErrConnectionClosed) {
		return true
	}
	var request gocql.RequestError
	if errors.As(err, &request) {
		switch request.Code() {
		case gocql.ErrCodeOverloaded, gocql.ErrCodeBootstrapping, gocql.ErrCodeTruncate:
			return true
		}
	}
	return false
}

// Rejected is deliberately conservative. A CQL invalid request can indicate
// schema drift or a service bug, so it must hold the Kafka offset for repair.
func Rejected(err error) bool {
	return false
}
