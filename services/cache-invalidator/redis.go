package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// bumpScript raises a version to max(current+1, floor) and optionally refreshes its TTL.
// A clock floor keeps versions increasing even if a failover lost the last increment.
const bumpScript = `local current = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
local next = math.max(current + 1, tonumber(ARGV[1]))
redis.call('SET', KEYS[1], string.format('%d', next))
if tonumber(ARGV[2]) > 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
redis.call('PUBLISH', ARGV[3], ARGV[4])
return next`

const liveChannel = "gg:read:v1:live"

var bump = redis.NewScript(bumpScript)

// RedisBumper runs the bump script against a cluster or single-node client.
type RedisBumper struct{ client redis.UniversalClient }

func (r RedisBumper) Bump(ctx context.Context, key string, floor int64, ttl time.Duration) error {
	hint, err := liveHint(key)
	if err != nil {
		return err
	}
	return bump.Run(ctx, r.client, []string{key}, floor, ttl.Milliseconds(), liveChannel, hint).Err()
}

// The hint is published in the same Redis script as the cache bump. A consumer
// can miss pub/sub messages, so it always refetches the durable read model.
func liveHint(key string) (string, error) {
	hint := struct {
		Scope  string `json:"scope"`
		Tenant string `json:"tenant,omitempty"`
		Device string `json:"device,omitempty"`
	}{}
	if key == epochKey {
		hint.Scope = scopeEpoch
	} else {
		prefix := keyPrefix + ":{t:"
		if !strings.HasPrefix(key, prefix) {
			return "", errors.New("invalid live hint key")
		}
		rest := strings.TrimPrefix(key, prefix)
		tenant, suffix, ok := strings.Cut(rest, "}")
		if !ok || !safeID.MatchString(tenant) {
			return "", errors.New("invalid live hint tenant")
		}
		hint.Tenant = tenant
		if suffix == ":gen" {
			hint.Scope = scopeTenant
		} else if strings.HasPrefix(suffix, ":d:") && strings.HasSuffix(suffix, ":ver") {
			device := strings.TrimSuffix(strings.TrimPrefix(suffix, ":d:"), ":ver")
			if !safeID.MatchString(device) {
				return "", errors.New("invalid live hint device")
			}
			hint.Scope, hint.Device = scopeDevice, device
		} else {
			return "", errors.New("invalid live hint key")
		}
	}
	encoded, err := json.Marshal(hint)
	return string(encoded), err
}

func (r RedisBumper) Ping(ctx context.Context) error { return r.client.Ping(ctx).Err() }
func (r RedisBumper) Close() error                   { return r.client.Close() }

// parseAddressMap parses `host:port=host:port,...`, matching the Read API's
// READ_REDIS_NODE_ADDRESS_MAP, so hosts outside Docker reach announced node names.
func parseAddressMap(value string) (map[string]string, error) {
	out := map[string]string{}
	for _, pair := range strings.Split(value, ",") {
		if pair = strings.TrimSpace(pair); pair == "" {
			continue
		}
		from, to, ok := strings.Cut(pair, "=")
		if _, _, err := net.SplitHostPort(to); !ok || from == "" || err != nil {
			return nil, errors.New("invalid READ_REDIS_NODE_ADDRESS_MAP")
		}
		out[from] = to
	}
	return out, nil
}

func nodeAddress(raw string) string {
	if parsed, err := url.Parse(raw); err == nil && parsed.Host != "" {
		return parsed.Host
	}
	return raw
}

// newRedis builds a fail-fast client: go-redis retries are off because the worker owns
// the bounded retry budget, and every command also carries the worker's deadline.
func newRedis(getenv func(string) string, timeout time.Duration) (RedisBumper, error) {
	mapping, err := parseAddressMap(getenv("READ_REDIS_NODE_ADDRESS_MAP"))
	if err != nil {
		return RedisBumper{}, err
	}
	dialer := &net.Dialer{Timeout: timeout}
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		if mapped, ok := mapping[addr]; ok {
			addr = mapped
		}
		return dialer.DialContext(ctx, network, addr)
	}
	var nodes []string
	for _, node := range strings.Split(getenv("READ_REDIS_CLUSTER_NODES"), ",") {
		if node = strings.TrimSpace(node); node != "" {
			nodes = append(nodes, nodeAddress(node))
		}
	}
	if len(nodes) > 0 {
		return RedisBumper{redis.NewClusterClient(&redis.ClusterOptions{Addrs: nodes, Dialer: dial,
			DialTimeout: timeout, ReadTimeout: timeout, WriteTimeout: timeout, MaxRetries: -1,
			ContextTimeoutEnabled: true})}, nil
	}
	single := getenv("READ_REDIS_URL")
	if single == "" {
		return RedisBumper{}, errors.New("READ_REDIS_CLUSTER_NODES or READ_REDIS_URL is required")
	}
	options, err := redis.ParseURL(single)
	if err != nil {
		return RedisBumper{}, errors.New("invalid READ_REDIS_URL")
	}
	options.Dialer, options.DialTimeout, options.ReadTimeout, options.WriteTimeout = dial, timeout, timeout, timeout
	options.MaxRetries, options.ContextTimeoutEnabled = -1, true
	return RedisBumper{redis.NewClient(options)}, nil
}
