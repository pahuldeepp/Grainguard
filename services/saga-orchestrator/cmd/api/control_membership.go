package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
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
	url, token string
	client     *http.Client
	redis      redis.UniversalClient
	brokers    []string
	mu         sync.Mutex
	entries    map[string]membershipEntry
	floors     map[string]map[string]uint64
	consumer   *kgo.Client
	cancel     context.CancelFunc
}

func newControlMembershipCache(getenv func(string) string, client *http.Client) (*controlMembershipCache, error) {
	base, err := controlPlaneURL(getenv("CONTROL_PLANE_URL"))
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

func controlPlaneURL(raw string) (*url.URL, error) {
	base, err := url.Parse(raw)
	if err != nil || base == nil || base.Host == "" || (base.Scheme != "https" && !(base.Scheme == "http" && (base.Hostname() == "localhost" || base.Hostname() == "127.0.0.1"))) {
		return nil, errors.New("CONTROL_PLANE_URL must be https or loopback http")
	}
	return base, nil
}

func membershipRedisClient(getenv func(string) string) (redis.UniversalClient, error) {
	nodes := strings.Split(getenv("AUTH_MEMBERSHIP_REDIS_CLUSTER_NODES"), ",")
	if len(nodes) == 0 || strings.TrimSpace(nodes[0]) == "" {
		opt, err := redis.ParseURL(getenv("AUTH_MEMBERSHIP_REDIS_URL"))
		if err != nil {
			return nil, errors.New("AUTH_MEMBERSHIP_REDIS_URL is required")
		}
		return redis.NewClient(opt), nil
	}
	addressMap, err := membershipRedisAddressMap(getenv("AUTH_MEMBERSHIP_REDIS_NODE_ADDRESS_MAP"))
	if err != nil {
		return nil, err
	}
	addresses, err := membershipRedisAddresses(nodes)
	if err != nil {
		return nil, err
	}
	return redis.NewClusterClient(&redis.ClusterOptions{Addrs: addresses, NewClient: func(opt *redis.Options) *redis.Client {
		if mapped, ok := addressMap[opt.Addr]; ok {
			opt.Addr = mapped
		}
		return redis.NewClient(opt)
	}}), nil
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

func membershipRedisAddresses(nodes []string) ([]string, error) {
	addresses := make([]string, 0, len(nodes))
	for _, node := range nodes {
		u, err := url.Parse(strings.TrimSpace(node))
		if err != nil || u.Host == "" {
			return nil, errors.New("invalid membership Redis cluster node")
		}
		addresses = append(addresses, u.Host)
	}
	return addresses, nil
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
	c.mu.Unlock()
	ttl := 30 * time.Second
	if entry.value == nil {
		ttl = 5 * time.Second
	}
	if !ok || now.Sub(entry.fetched) >= ttl {
		var err error
		entry, ok, err = c.refresh(ctx, issuer, subject, id, now, entry, ok)
		if errors.Is(err, errMembershipFloorUnavailable) {
			return "", nil, err
		}
		if err != nil && (!ok || now.Sub(entry.fetched) >= 5*time.Minute) {
			return "", nil, err
		}
	}
	return cachedMembershipRoles(entry, ok)
}

var errMembershipFloorUnavailable = errors.New("membership version floor unavailable")

func (c *controlMembershipCache) refresh(ctx context.Context, issuer, subject, id string, now time.Time, entry membershipEntry, ok bool) (membershipEntry, bool, error) {
	fresh, err := c.fetch(ctx, issuer, subject)
	if err != nil {
		return entry, ok, err
	}
	if fresh == nil {
		c.mu.Lock()
		defer c.mu.Unlock()
		entry = membershipEntry{fetched: now}
		c.entries[id] = entry
		return entry, true, nil
	}
	version, _ := parseVersion(fresh.Version)
	if err := c.checkMembershipFloor(ctx, id, fresh.TenantID, version); err != nil {
		return entry, ok, err
	}
	if err := c.storeFreshMembership(id, fresh, version, now); err != nil {
		return entry, ok, err
	}
	return membershipEntry{value: fresh, fetched: now}, true, nil
}

func (c *controlMembershipCache) checkMembershipFloor(ctx context.Context, id, tenant string, version uint64) error {
	floor, err := c.redis.Get(ctx, membershipRedisKey(id, tenant)).Result()
	if err != nil && err != redis.Nil {
		return fmt.Errorf("%w: %v", errMembershipFloorUnavailable, err)
	}
	if floor == "" {
		return nil
	}
	n, err := parseVersion(floor)
	if err != nil || version < n {
		return errors.New("stale membership lookup")
	}
	return nil
}

func (c *controlMembershipCache) storeFreshMembership(id string, fresh *controlMembership, version uint64, now time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if version < c.floors[id][fresh.TenantID] {
		return errors.New("stale membership event")
	}
	c.entries[id] = membershipEntry{value: fresh, fetched: now}
	return nil
}

func cachedMembershipRoles(entry membershipEntry, ok bool) (string, map[string]bool, error) {
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

var errMembershipRevoked = errors.New("membership revoked")

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
	return c.applyMembershipVersion(ctx, event, version)
}

func (c *controlMembershipCache) applyMembershipVersion(ctx context.Context, event membershipEvent, version uint64) error {
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
	consumer, err := kgo.NewClient(kgo.SeedBrokers(c.brokers...), kgo.ConsumerGroup("saga-api-membership-"+strconv.FormatInt(time.Now().UnixNano(), 10)), kgo.ConsumeTopics("greenguard.inventory.tenant.v1"), kgo.DisableAutoCommit())
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
	go c.consumeMembershipLoop(loopCtx, consumer)
	return nil
}

func (c *controlMembershipCache) consumeMembershipLoop(ctx context.Context, consumer *kgo.Client) {
	for ctx.Err() == nil {
		fetches := consumer.PollFetches(ctx)
		fetches.EachError(func(_ string, _ int32, err error) {
			if ctx.Err() == nil {
				fmt.Printf("membership consumer error: %v\n", err)
			}
		})
		fetches.EachRecord(func(record *kgo.Record) {
			c.consumeMembershipRecord(ctx, consumer, record)
		})
	}
}

func (c *controlMembershipCache) consumeMembershipRecord(ctx context.Context, consumer *kgo.Client, record *kgo.Record) {
	if len(record.Value) > 1<<20 {
		_ = consumer.CommitRecords(ctx, record)
		return
	}
	var event membershipEvent
	if json.Unmarshal(record.Value, &event) != nil || !validMembershipEvent(event) {
		_ = consumer.CommitRecords(ctx, record)
		return
	}
	if c.apply(ctx, event) == nil {
		_ = consumer.CommitRecords(ctx, record)
	}
}

func validMembershipEvent(event membershipEvent) bool {
	if event.EventType != "membership.changed" {
		return true
	}
	if _, err := parseVersion(event.Payload.Version); err != nil {
		return false
	}
	return event.Payload.IdentityID != "" && event.TenantID != ""
}
func (c *controlMembershipCache) close() {
	if c.cancel != nil {
		c.cancel()
	}
	if c.consumer != nil {
		c.consumer.Close()
	}
	_ = c.redis.Close()
}
