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
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
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
	base, err := url.Parse(getenv("CONTROL_PLANE_URL"))
	if err != nil || base == nil || base.Host == "" || (base.Scheme != "https" && !(base.Scheme == "http" && (base.Hostname() == "localhost" || base.Hostname() == "127.0.0.1"))) {
		return nil, errors.New("CONTROL_PLANE_URL must be https or loopback http")
	}
	token := getenv("CONTROL_LOOKUP_TOKEN")
	if token == "" {
		return nil, errors.New("CONTROL_LOOKUP_TOKEN is required")
	}
	brokers := strings.FieldsFunc(getenv("AUTH_MEMBERSHIP_KAFKA_BROKERS"), func(r rune) bool { return r == ',' || r == ' ' })
	if len(brokers) == 0 {
		return nil, errors.New("AUTH_MEMBERSHIP_KAFKA_BROKERS is required")
	}
	var rc redis.UniversalClient
	if nodes := strings.Split(getenv("AUTH_MEMBERSHIP_REDIS_CLUSTER_NODES"), ","); len(nodes) > 0 && strings.TrimSpace(nodes[0]) != "" {
		addressMap := map[string]string{}
		for _, pair := range strings.Split(getenv("AUTH_MEMBERSHIP_REDIS_NODE_ADDRESS_MAP"), ",") {
			if pair == "" {
				continue
			}
			parts := strings.SplitN(pair, "=", 2)
			if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
				return nil, errors.New("invalid membership Redis address map")
			}
			addressMap[parts[0]] = parts[1]
		}
		addresses := make([]string, 0, len(nodes))
		for _, node := range nodes {
			u, err := url.Parse(strings.TrimSpace(node))
			if err != nil || u.Host == "" {
				return nil, errors.New("invalid membership Redis cluster node")
			}
			addresses = append(addresses, u.Host)
		}
		rc = redis.NewClusterClient(&redis.ClusterOptions{Addrs: addresses, NewClient: func(opt *redis.Options) *redis.Client {
			if mapped, ok := addressMap[opt.Addr]; ok {
				opt.Addr = mapped
			}
			return redis.NewClient(opt)
		}})
	} else {
		opt, err := redis.ParseURL(getenv("AUTH_MEMBERSHIP_REDIS_URL"))
		if err != nil {
			return nil, errors.New("AUTH_MEMBERSHIP_REDIS_URL is required")
		}
		rc = redis.NewClient(opt)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := rc.Ping(ctx).Err(); err != nil {
		_ = rc.Close()
		return nil, fmt.Errorf("membership Redis unavailable: %w", err)
	}
	return &controlMembershipCache{url: base.String(), token: token, client: client, redis: rc, brokers: brokers, entries: map[string]membershipEntry{}, floors: map[string]map[string]uint64{}}, nil
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
		fresh, err := c.fetch(ctx, issuer, subject)
		if err == nil && fresh != nil {
			version, _ := parseVersion(fresh.Version)
			floor, err := c.redis.Get(ctx, membershipRedisKey(id, fresh.TenantID)).Result()
			if err != nil && err != redis.Nil {
				return "", nil, err
			}
			if err == redis.Nil {
				err = nil
			}
			if floor != "" {
				n, e := parseVersion(floor)
				if e != nil || version < n {
					err = errors.New("stale membership lookup")
				}
			}
			c.mu.Lock()
			if version < c.floors[id][fresh.TenantID] {
				err = errors.New("stale membership event")
			}
			if err == nil {
				entry = membershipEntry{fresh, now}
				c.entries[id] = entry
				ok = true
			}
			c.mu.Unlock()
		} else if err == nil {
			c.mu.Lock()
			entry = membershipEntry{nil, now}
			c.entries[id] = entry
			ok = true
			c.mu.Unlock()
		}
		if err != nil && (!ok || now.Sub(entry.fetched) >= 5*time.Minute) {
			return "", nil, err
		}
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
	go func() {
		for loopCtx.Err() == nil {
			fetches := consumer.PollFetches(loopCtx)
			fetches.EachError(func(_ string, _ int32, err error) {
				if loopCtx.Err() == nil {
					fmt.Printf("membership consumer error: %v\n", err)
				}
			})
			fetches.EachRecord(func(record *kgo.Record) {
				if len(record.Value) > 1<<20 {
					_ = consumer.CommitRecords(loopCtx, record)
					return
				}
				var event membershipEvent
				if json.Unmarshal(record.Value, &event) != nil {
					_ = consumer.CommitRecords(loopCtx, record)
					return
				}
				if event.EventType == "membership.changed" {
					if _, err := parseVersion(event.Payload.Version); err != nil || event.Payload.IdentityID == "" || event.TenantID == "" {
						_ = consumer.CommitRecords(loopCtx, record)
						return
					}
				}
				if err := c.apply(loopCtx, event); err == nil {
					_ = consumer.CommitRecords(loopCtx, record)
				}
			})
		}
	}()
	return nil
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
