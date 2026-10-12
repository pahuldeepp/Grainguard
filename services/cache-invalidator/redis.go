package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
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
if #KEYS>1 then redis.call('DEL',KEYS[2]); redis.call('INCR',KEYS[3]) end
redis.call('PUBLISH', ARGV[3], ARGV[4])
return next`

const liveChannel = "gg:read:v1:live"

var bump = redis.NewScript(bumpScript)

// Notifications may advance a current guard, but can never create placement.
// Missing guards are rebuilt by a leased Read API from its owning primary.
const advanceWatermarkScript = `local function ge(a,b) return #a>#b or (#a==#b and a>=b) end
local raw=redis.call('GET',KEYS[1]); local next=cjson.decode(ARGV[1])
if raw then
 local ok,old=pcall(cjson.decode,raw)
 if not ok or type(old)~='table' or type(old.sequence)~='string' then return redis.error_reply('invalid watermark guard') end
 if old.tenantId~=next.tenantId or old.shardIncarnation~=next.shardIncarnation or old.placementEpoch~=next.placementEpoch then return 0 end
 if ge(next.sequence,old.sequence) then redis.call('SET',KEYS[1],ARGV[1],'PX',600000) end
end
redis.call('INCR',KEYS[2])
redis.call('PUBLISH',ARGV[2],ARGV[3]); return 1`

var advanceWatermark = redis.NewScript(advanceWatermarkScript)

// RedisBumper runs the bump script against a cluster or single-node client.
type RedisBumper struct{ client redis.UniversalClient }

func (r RedisBumper) Advance(ctx context.Context, t Target) error {
	watermark := struct {
		V           int    `json:"v"`
		Tenant      string `json:"tenantId"`
		Incarnation string `json:"shardIncarnation"`
		Epoch       string `json:"placementEpoch"`
		Sequence    string `json:"sequence"`
	}{1, t.Tenant, t.Incarnation, t.PlacementEpoch, t.Sequence}
	encoded, err := json.Marshal(watermark)
	if err != nil {
		return err
	}
	hint, err := json.Marshal(map[string]string{"scope": t.Scope, "tenant": t.Tenant, "device": t.Device, "shard_incarnation": t.Incarnation, "placement_epoch": t.PlacementEpoch, "projection_sequence": t.Sequence})
	if err != nil {
		return err
	}
	guard := watermarkGuardKey(t.Tenant)
	return advanceWatermark.Run(ctx, r.client, []string{guard, guard + ":revision"}, string(encoded), liveChannel, string(hint)).Err()
}

func (r RedisBumper) Bump(ctx context.Context, key string, floor int64, ttl time.Duration) error {
	return r.bumpKey(ctx, key, floor, ttl, true)
}
func (r RedisBumper) BumpTarget(ctx context.Context, t Target, floor int64, ttl time.Duration) error {
	return r.bumpKey(ctx, t.Key(), floor, ttl, t.Incarnation == "")
}
func (r RedisBumper) bumpKey(ctx context.Context, key string, floor int64, ttl time.Duration, legacy bool) error {
	hint, err := liveHint(key)
	if err != nil {
		return err
	}
	keys := []string{key}
	if key != epochKey && legacy {
		// Legacy invalidation has no watermark proof. Remove its tenant guard so
		// a future v2 read must rebuild from durable primary state, never infer zero.
		var scope struct {
			Tenant string `json:"tenant"`
		}
		if err = json.Unmarshal([]byte(hint), &scope); err != nil {
			return err
		}
		guard := watermarkGuardKey(scope.Tenant)
		keys = append(keys, guard, guard+":revision")
	}
	return bump.Run(ctx, r.client, keys, floor, ttl.Milliseconds(), liveChannel, hint).Err()
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

func redisDialer(mapping map[string]string, timeout time.Duration, config *tls.Config) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		target := addr
		if mapped, ok := mapping[addr]; ok {
			target = mapped
		}
		dialer := &net.Dialer{Timeout: timeout}
		if config == nil {
			return dialer.DialContext(ctx, network, target)
		}
		verified := config.Clone()
		verified.ServerName = host
		return (&tls.Dialer{NetDialer: dialer, Config: verified}).DialContext(ctx, network, target)
	}
}

func parseClusterNodes(raw string) ([]string, *redis.Options, error) {
	var nodes []string
	var clusterAuth *redis.Options
	for _, node := range strings.Split(raw, ",") {
		if node = strings.TrimSpace(node); node != "" {
			if !strings.Contains(node, "://") {
				node = "redis://" + node
			}
			options, err := redis.ParseURL(node)
			if err != nil || options.DB != 0 {
				return nil, nil, errors.New("invalid READ_REDIS_CLUSTER_NODES")
			}
			if clusterAuth == nil {
				clusterAuth = options
			} else if options.Username != clusterAuth.Username || options.Password != clusterAuth.Password || (options.TLSConfig == nil) != (clusterAuth.TLSConfig == nil) {
				return nil, nil, errors.New("Redis cluster nodes must use matching credentials and TLS mode")
			}
			nodes = append(nodes, options.Addr)
		}
	}
	return nodes, clusterAuth, nil
}

// newRedis builds a fail-fast client: go-redis retries are off because the worker owns
// the bounded retry budget, and every command also carries the worker's deadline.
func newRedis(getenv func(string) string, timeout time.Duration) (RedisBumper, error) {
	mapping, err := parseAddressMap(getenv("READ_REDIS_NODE_ADDRESS_MAP"))
	if err != nil {
		return RedisBumper{}, err
	}
	nodes, clusterAuth, err := parseClusterNodes(getenv("READ_REDIS_CLUSTER_NODES"))
	if err != nil {
		return RedisBumper{}, err
	}
	if len(nodes) > 0 {
		return RedisBumper{redis.NewClusterClient(&redis.ClusterOptions{Addrs: nodes, Username: clusterAuth.Username, Password: clusterAuth.Password, TLSConfig: clusterAuth.TLSConfig, Dialer: redisDialer(mapping, timeout, clusterAuth.TLSConfig),
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
	options.Dialer, options.DialTimeout, options.ReadTimeout, options.WriteTimeout = redisDialer(mapping, timeout, options.TLSConfig), timeout, timeout, timeout
	options.MaxRetries, options.ContextTimeoutEnabled = -1, true
	return RedisBumper{redis.NewClient(options)}, nil
}
