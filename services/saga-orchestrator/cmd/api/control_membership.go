package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
	common "greenguard.local/go-common"
	transport "greenguard.local/kafka-transport"
)

type controlMembership struct {
	TenantID string   `json:"tenantId"`
	Roles    []string `json:"roles"`
	Version  string   `json:"version"`
	State    string   `json:"state"`
}
type membershipEntry struct {
	value   *controlMembership
	fetched time.Time
}
type controlMembershipCache struct {
	url, token        string
	client            *http.Client
	redis             redis.UniversalClient
	brokers           []string
	mu                sync.Mutex
	entries           map[string]membershipEntry
	floors            map[string]map[string]uint64
	consumer          *kgo.Client
	cancel            context.CancelFunc
	consumerErr       error
	consumerCloseOnce sync.Once
}

func newControlMembershipCache(getenv func(string) string, client *http.Client) (*controlMembershipCache, error) {
	base, err := controlPlaneURL(getenv)
	if err != nil {
		return nil, err
	}
	token := getenv("CONTROL_LOOKUP_TOKEN")
	if token == "" {
		return nil, errors.New("CONTROL_LOOKUP_TOKEN is required")
	}
	brokers := strings.FieldsFunc(getenv("AUTH_MEMBERSHIP_KAFKA_BROKERS"), func(r rune) bool { return r == ',' || r == ' ' })
	if len(brokers) == 0 {
		return nil, errors.New("AUTH_MEMBERSHIP_KAFKA_BROKERS is required")
	}
	rc, err := membershipRedisClient(getenv)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := rc.Ping(ctx).Err(); err != nil {
		_ = rc.Close()
		return nil, fmt.Errorf("membership Redis unavailable: %w", err)
	}
	return &controlMembershipCache{url: base.String(), token: token, client: client, redis: rc, brokers: brokers, entries: map[string]membershipEntry{}, floors: map[string]map[string]uint64{}}, nil
}

func controlPlaneURL(getenv func(string) string) (*url.URL, error) {
	base, err := url.Parse(getenv("CONTROL_PLANE_URL"))
	if err != nil || base == nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("CONTROL_PLANE_URL must be https or loopback http")
	}
	meshHTTP := getenv("CONTROL_PLANE_MESH_MTLS") == "true" && common.InternalMeshHost(base.Hostname())
	loopback := base.Hostname() == "localhost" || base.Hostname() == "127.0.0.1"
	if base.Scheme != "https" && !(base.Scheme == "http" && (loopback || meshHTTP)) {
		return nil, errors.New("CONTROL_PLANE_URL must be https or loopback http")
	}
	return base, nil
}

func membershipRedisClient(getenv func(string) string) (redis.UniversalClient, error) {
	rawNodes := getenv("AUTH_MEMBERSHIP_REDIS_CLUSTER_NODES")
	if strings.TrimSpace(rawNodes) == "" {
		opt, err := redis.ParseURL(getenv("AUTH_MEMBERSHIP_REDIS_URL"))
		if err != nil {
			return nil, errors.New("AUTH_MEMBERSHIP_REDIS_URL is required")
		}
		if opt.TLSConfig != nil && opt.TLSConfig.InsecureSkipVerify {
			return nil, errors.New("membership Redis TLS verification must be enabled")
		}
		opt.ContextTimeoutEnabled = true
		configureMembershipRedisTLS(opt)
		return redis.NewClient(opt), nil
	}
	nodes := strings.Split(rawNodes, ",")
	addressMap, err := membershipRedisAddressMap(getenv("AUTH_MEMBERSHIP_REDIS_NODE_ADDRESS_MAP"))
	if err != nil {
		return nil, err
	}
	options, err := membershipRedisClusterOptions(nodes)
	if err != nil {
		return nil, err
	}
	options.ContextTimeoutEnabled = true
	options.NewClient = func(opt *redis.Options) *redis.Client {
		// Verify the announced node's identity even when a local fixture maps
		// the dial address. Each node owns its TLS clone and server name.
		configureMembershipRedisTLS(opt)
		if mapped, ok := addressMap[opt.Addr]; ok {
			opt.Addr = mapped
		}
		return redis.NewClient(opt)
	}
	return redis.NewClusterClient(options), nil
}

func configureMembershipRedisTLS(opt *redis.Options) {
	if opt.TLSConfig == nil {
		return
	}
	opt.TLSConfig = opt.TLSConfig.Clone()
	opt.TLSConfig.ServerName = membershipRedisServerName(opt.Addr)
	timeout := opt.DialTimeout
	if timeout == 0 {
		timeout = 5 * time.Second // Match go-redis's default before Options.init.
	}
	dialer := &tls.Dialer{
		NetDialer: &net.Dialer{Timeout: timeout, KeepAlive: 5 * time.Minute},
		Config:    opt.TLSConfig,
	}
	// go-redis's default TLS dialer does not pass the operation context to
	// the handshake. Cancellation must bound connection acquisition too.
	opt.Dialer = dialer.DialContext
}

func membershipRedisServerName(announced string) string {
	host, _, err := net.SplitHostPort(announced)
	if err != nil || host == "" {
		return announced
	}
	return host
}

func membershipRedisAddressMap(raw string) (map[string]string, error) {
	addressMap := map[string]string{}
	for _, pair := range strings.Split(raw, ",") {
		if pair == "" {
			continue
		}
		parts := strings.SplitN(pair, "=", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return nil, errors.New("invalid membership Redis address map")
		}
		addressMap[parts[0]] = parts[1]
	}
	return addressMap, nil
}

func membershipRedisClusterOptions(nodes []string) (*redis.ClusterOptions, error) {
	var options *redis.ClusterOptions
	for _, node := range nodes {
		parsed, err := parseMembershipRedisClusterNode(node)
		if err != nil {
			return nil, err
		}
		if options == nil {
			options = parsed
			continue
		}
		if !sameMembershipRedisProfile(options, parsed) {
			return nil, errors.New("membership Redis cluster nodes have mixed connection profiles")
		}
		options.Addrs = append(options.Addrs, parsed.Addrs...)
	}
	if options == nil {
		return nil, errors.New("membership Redis cluster nodes are required")
	}
	if options.TLSConfig != nil {
		options.TLSConfig.ServerName = "" // Set separately for each discovered node.
	}
	return options, nil
}

func parseMembershipRedisClusterNode(raw string) (*redis.ClusterOptions, error) {
	invalid := errors.New("invalid membership Redis cluster node")
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.Fragment != "" {
		return nil, invalid
	}
	if u.Path != "" && u.Path != "/" && u.Path != "/0" {
		return nil, invalid // Redis Cluster supports database zero only.
	}
	options, err := redis.ParseClusterURL(raw)
	if err != nil || len(options.Addrs) != 1 || options.ReadOnly || options.RouteByLatency || options.RouteRandomly {
		return nil, invalid
	}
	if options.TLSConfig != nil {
		options.TLSConfig.MinVersion = tls.VersionTLS12
	}
	return options, nil
}

func sameMembershipRedisProfile(a, b *redis.ClusterOptions) bool {
	if (a.TLSConfig == nil) != (b.TLSConfig == nil) {
		return false
	}
	left, right := *a, *b
	left.Addrs, right.Addrs = nil, nil
	left.TLSConfig, right.TLSConfig = nil, nil
	return reflect.DeepEqual(left, right)
}

func identityID(issuer, subject string) string {
	sum := sha256.Sum256([]byte("identity\n" + issuer + "\n" + subject))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x50
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
func membershipRedisKey(id, tenant string) string {
	return "greenguard:membership:{" + id + "}:" + tenant + ":version"
}
func parseVersion(s string) (uint64, error) {
	n, e := strconv.ParseUint(s, 10, 64)
	if e != nil || n == 0 || n > 9223372036854775807 {
		return 0, errors.New("invalid membership version")
	}
	return n, nil
}

func (c *controlMembershipCache) fetch(ctx context.Context, issuer, subject string) (*controlMembership, error) {
	u, _ := url.Parse(c.url)
	u.Path = "/v1/internal/memberships"
	q := u.Query()
	q.Set("issuer", issuer)
	q.Set("subject", subject)
	u.RawQuery = q.Encode()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	res, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		return nil, nil
	}
	if res.StatusCode != 200 {
		return nil, errors.New("membership lookup failed")
	}
	var m controlMembership
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&m); err != nil {
		return nil, err
	}
	if _, err := parseVersion(m.Version); err != nil {
		return nil, err
	}
	if m.TenantID == "" || (m.State != "active" && m.State != "revoked") || (m.State == "active" && len(m.Roles) == 0) || (m.State == "revoked" && len(m.Roles) != 0) {
		return nil, errors.New("malformed membership response")
	}
	for _, role := range m.Roles {
		if !validRole(role) {
			return nil, errors.New("invalid membership role")
		}
	}
	return &m, nil
}

func (c *controlMembershipCache) roles(ctx context.Context, issuer, subject string) (string, map[string]bool, error) {
	id := identityID(issuer, subject)
	now := time.Now()
	c.mu.Lock()
	entry, ok := c.entries[id]
	consumerErr := c.consumerErr
	c.mu.Unlock()
	if consumerErr != nil {
		return "", nil, consumerErr
	}
	ttl := 30 * time.Second
	if entry.value == nil {
		ttl = 5 * time.Second
	}
	if !ok || now.Sub(entry.fetched) >= ttl {
		var err error
		entry, ok, err = c.refreshMembership(ctx, issuer, subject, id, now, entry, ok)
		if err != nil {
			return "", nil, fmt.Errorf("%w: %v", errMembershipUnavailable, err)
		}
	}
	if consumerErr = c.membershipConsumerError(); consumerErr != nil {
		return "", nil, consumerErr
	}
	if !ok || entry.value == nil {
		return "", nil, errors.New("identity has no active GreenGuard membership")
	}
	if entry.value.State == "revoked" {
		return "", nil, errMembershipRevoked
	}
	roles := map[string]bool{}
	for _, role := range entry.value.Roles {
		roles[role] = true
	}
	return entry.value.TenantID, roles, nil
}

// refreshMembership preserves the bounded fallback for lookup/staleness errors.
// Redis availability errors are returned immediately, even with a cached entry.
func (c *controlMembershipCache) refreshMembership(ctx context.Context, issuer, subject, id string, now time.Time, entry membershipEntry, ok bool) (membershipEntry, bool, error) {
	fresh, err := c.fetch(ctx, issuer, subject)
	if err == nil && fresh != nil {
		version, _ := parseVersion(fresh.Version)
		floor, redisErr := c.redisMembershipFloor(ctx, id, fresh.TenantID)
		if redisErr != nil {
			return entry, ok, redisErr
		}
		err = validateMembershipFloor(floor, version)
		entry, ok, err = c.cacheFreshMembership(id, fresh, version, now, entry, ok, err)
	} else if err == nil {
		c.mu.Lock()
		entry = membershipEntry{nil, now}
		c.entries[id] = entry
		ok = true
		c.mu.Unlock()
	}
	if err != nil && (!ok || now.Sub(entry.fetched) >= 5*time.Minute) {
		return entry, ok, err
	}
	return entry, ok, nil
}

func validateMembershipFloor(floor string, version uint64) error {
	if floor == "" {
		return nil
	}
	n, err := parseVersion(floor)
	if err != nil || version < n {
		return errors.New("stale membership lookup")
	}
	return nil
}

func (c *controlMembershipCache) redisMembershipFloor(ctx context.Context, id, tenant string) (string, error) {
	floor, err := c.redis.Get(ctx, membershipRedisKey(id, tenant)).Result()
	if err == redis.Nil {
		err = nil
	}
	return floor, err
}

func (c *controlMembershipCache) cacheFreshMembership(id string, fresh *controlMembership, version uint64, now time.Time, entry membershipEntry, ok bool, err error) (membershipEntry, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if version < c.floors[id][fresh.TenantID] {
		err = errors.New("stale membership event")
	}
	if err == nil {
		entry = membershipEntry{fresh, now}
		c.entries[id] = entry
		ok = true
	}
	return entry, ok, err
}

var errMembershipRevoked = errors.New("membership revoked")
var errMembershipUnavailable = errors.New("membership consumer unavailable")

const membershipRecordAttempts = 3

const advanceMembershipVersion = `local old=redis.call('GET',KEYS[1]); local next=ARGV[1]; if not old or string.len(next)>string.len(old) or (string.len(next)==string.len(old) and next>old) then redis.call('SET',KEYS[1],next,'PX',600000) end; return 1`

type membershipEvent struct {
	EventType string `json:"event_type"`
	TenantID  string `json:"tenant_id"`
	Payload   struct {
		IdentityID string `json:"identity_id"`
		Version    string `json:"membership_version"`
	} `json:"payload"`
}

func (c *controlMembershipCache) apply(ctx context.Context, event membershipEvent) error {
	if event.EventType != "membership.changed" {
		return nil
	}
	version, err := parseVersion(event.Payload.Version)
	if err != nil || event.Payload.IdentityID == "" || event.TenantID == "" {
		return errors.New("invalid membership event")
	}
	if err := c.redis.Eval(ctx, advanceMembershipVersion, []string{membershipRedisKey(event.Payload.IdentityID, event.TenantID)}, event.Payload.Version).Err(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	byTenant := c.floors[event.Payload.IdentityID]
	if byTenant == nil {
		byTenant = map[string]uint64{}
		c.floors[event.Payload.IdentityID] = byTenant
	}
	if version > byTenant[event.TenantID] {
		byTenant[event.TenantID] = version
		// A grant in another tenant may make this identity ambiguous, so refresh
		// the whole identity on any newer membership event.
		delete(c.entries, event.Payload.IdentityID)
	}
	return nil
}
func (c *controlMembershipCache) startConsumer(ctx context.Context) error {
	security, err := transport.SecurityOptions(os.Getenv)
	if err != nil {
		return err
	}
	options := append([]kgo.Opt{kgo.SeedBrokers(c.brokers...), kgo.ConsumerGroup("saga-api-membership-" + strconv.FormatInt(time.Now().UnixNano(), 10)), kgo.ConsumeTopics("greenguard.inventory.tenant.v1"), kgo.DisableAutoCommit()}, security...)
	consumer, err := kgo.NewClient(options...)
	if err != nil {
		return err
	}
	if err := consumer.Ping(ctx); err != nil {
		consumer.Close()
		return err
	}
	c.consumer = consumer
	loopCtx, cancel := context.WithCancel(ctx)
	c.cancel = cancel
	go c.consumeMembership(loopCtx, consumer)
	return nil
}

type membershipConsumer interface {
	PollFetches(context.Context) kgo.Fetches
	CommitRecords(context.Context, ...*kgo.Record) error
	Close()
}

func (c *controlMembershipCache) consumeMembership(ctx context.Context, consumer membershipConsumer) {
	defer c.closeMembershipConsumer(consumer)
	for ctx.Err() == nil {
		fetches := consumer.PollFetches(ctx)
		if err := c.consumeMembershipBatch(ctx, fetches, consumer.CommitRecords); err != nil {
			if ctx.Err() == nil {
				c.setMembershipConsumerError(errMembershipUnavailable)
				fmt.Printf("membership consumer stopped: %v\n", err)
			}
			return
		}
	}
}

// Stop the entire batch at the first failure. No later offset, including in
// the same partition, may commit past an unapplied or uncommitted change.
func (c *controlMembershipCache) consumeMembershipBatch(ctx context.Context, fetches kgo.Fetches, commit func(context.Context, ...*kgo.Record) error) error {
	if errs := fetches.Errors(); len(errs) != 0 {
		return errs[0].Err
	}
	iter := fetches.RecordIter()
	for !iter.Done() {
		if err := c.retryMembershipRecord(ctx, iter.Next(), commit); err != nil {
			return err
		}
	}
	return nil
}

// Redis version-floor advancement and repeated commits of the same record are
// idempotent. Retry this record only; do not poll or advance a later offset.
func (c *controlMembershipCache) retryMembershipRecord(ctx context.Context, record *kgo.Record, commit func(context.Context, ...*kgo.Record) error) error {
	var err error
	for attempt := 0; attempt < membershipRecordAttempts; attempt++ {
		if err = ctx.Err(); err != nil {
			return err
		}
		if err = c.attemptMembershipRecord(ctx, record, commit); err == nil {
			c.setMembershipConsumerError(nil)
			return nil
		}
		c.setMembershipConsumerError(errMembershipUnavailable)
		if attempt < membershipRecordAttempts-1 {
			if waitErr := waitMembershipRetry(ctx, time.Duration(1<<attempt)*100*time.Millisecond); waitErr != nil {
				return waitErr
			}
		}
	}
	return err
}

func (c *controlMembershipCache) attemptMembershipRecord(ctx context.Context, record *kgo.Record, commit func(context.Context, ...*kgo.Record) error) error {
	attemptCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return c.consumeMembershipRecord(attemptCtx, record, commit)
}

func (c *controlMembershipCache) setMembershipConsumerError(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.consumerErr = err
}

func waitMembershipRetry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (c *controlMembershipCache) consumeMembershipRecord(ctx context.Context, record *kgo.Record, commit func(context.Context, ...*kgo.Record) error) error {
	event, valid := decodeMembershipEvent(record.Value)
	if valid {
		if err := c.apply(ctx, event); err != nil {
			return err
		}
	}
	return commit(ctx, record)
}

func (c *controlMembershipCache) closeMembershipConsumer(consumer membershipConsumer) {
	c.consumerCloseOnce.Do(func() {
		if group, ok := consumer.(interface{ LeaveGroupContext(context.Context) error }); ok {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = group.LeaveGroupContext(ctx)
		}
		consumer.Close()
	})
}

func (c *controlMembershipCache) membershipConsumerError() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.consumerErr
}

func decodeMembershipEvent(value []byte) (membershipEvent, bool) {
	var event membershipEvent
	if len(value) > 1<<20 || json.Unmarshal(value, &event) != nil {
		return event, false
	}
	if event.EventType == "membership.changed" {
		if _, err := parseVersion(event.Payload.Version); err != nil || event.Payload.IdentityID == "" || event.TenantID == "" {
			return event, false
		}
	}
	return event, true
}

func (c *controlMembershipCache) close() {
	if c.cancel != nil {
		c.cancel()
	}
	if c.consumer != nil {
		c.closeMembershipConsumer(c.consumer)
	}
	_ = c.redis.Close()
}
