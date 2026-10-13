package modelgateway

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

// ControlError carries only safe machine-readable failure information.
type ControlError struct {
	Code       string
	Status     int
	RetryAfter int
}

func (e *ControlError) Error() string { return e.Code }

type Limit struct {
	Capacity        int     `json:"capacity"`
	RefillPerSecond float64 `json:"refill_per_second"`
	Concurrent      int     `json:"concurrent"`
}

// TokenLimit is optional provider-wide weighted capacity. Values are quota
// units per bucket/refill second, not provider usage or an exact tokenizer count.
type TokenLimit struct {
	Capacity        int64   `json:"capacity"`
	RefillPerSecond float64 `json:"refill_per_second"`
}
type AdmissionConfig struct {
	ProviderTokens map[string]TokenLimit `json:"provider_tokens,omitempty"`
	Provider       map[string]Limit      `json:"provider"`
	Tenant         Limit                 `json:"tenant"`
	Query          Limit                 `json:"query"`
	Indexing       Limit                 `json:"indexing"`
	User           Limit                 `json:"user"`
	LeaseSeconds   int                   `json:"lease_seconds"`
}
type RedisAdmission struct {
	Client redis.UniversalClient
	Config AdmissionConfig
}

// All keys share the tenant hash slot. Inspect every bucket and lease before
// mutating any; rejected calls never debit another user's capacity. Redis TIME
// avoids replica clock skew. Sorted-set leases expire after bounded egress.
const admissionLua = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local retry=0; local balances={}
for i=1,#KEYS/2 do
 local capacity=tonumber(ARGV[4*i-1]); local refill=tonumber(ARGV[4*i]); local concurrent=tonumber(ARGV[4*i+1])
 local cost=tonumber(ARGV[4*i+2])
 if not cost or cost<1 or cost>capacity then return {-1,0} end
 local state=redis.call('HMGET',KEYS[2*i-1],'tokens','at')
 local balance=math.min(capacity,(tonumber(state[1]) or capacity)+math.max(0,now-(tonumber(state[2]) or now))*refill/1000)
 balances[i]=balance
 if balance<cost then retry=math.max(retry,math.ceil((cost-balance)*1000/refill)) end
 redis.call('ZREMRANGEBYSCORE',KEYS[2*i],'-inf',now)
 if redis.call('ZCARD',KEYS[2*i])>=concurrent then
  local first=redis.call('ZRANGE',KEYS[2*i],0,0,'WITHSCORES'); retry=math.max(retry,tonumber(first[2])-now)
 end
end
if retry>0 then return {0,math.ceil(retry)} end
for i=1,#KEYS/2 do
 local capacity=tonumber(ARGV[4*i-1]); local refill=tonumber(ARGV[4*i])
 redis.call('HSET',KEYS[2*i-1],'tokens',balances[i]-tonumber(ARGV[4*i+2]),'at',now)
 redis.call('PEXPIRE',KEYS[2*i-1],math.ceil(2*capacity*1000/refill))
 redis.call('ZADD',KEYS[2*i],now+tonumber(ARGV[2]),ARGV[1]); redis.call('PEXPIRE',KEYS[2*i],tonumber(ARGV[2])*2)
end
return {1,0}`
const releaseLua = `for i=1,#KEYS do redis.call('ZREM',KEYS[i],ARGV[1]) end return 1`

var admissionScript = redis.NewScript(admissionLua)
var releaseScript = redis.NewScript(releaseLua)

func (a *RedisAdmission) Validate(total time.Duration) error {
	if a == nil || a.Client == nil {
		return errors.New("Redis admission required")
	}
	limits := []Limit{a.Config.Tenant, a.Config.Query, a.Config.Indexing, a.Config.User}
	if len(a.Config.Provider) == 0 {
		return errors.New("provider limits required")
	}
	for provider, l := range a.Config.Provider {
		if provider != "voyage" && provider != "anthropic" && provider != "legacy" {
			return errors.New("invalid provider limit")
		}
		if a.Config.Tenant.Concurrent >= l.Concurrent || a.Config.Tenant.Capacity >= l.Capacity {
			return errors.New("tenant must leave provider capacity for other tenants")
		}
		limits = append(limits, l)
	}
	for _, l := range limits {
		if l.Capacity < 1 || l.Capacity > 1000000 || math.IsNaN(l.RefillPerSecond) || math.IsInf(l.RefillPerSecond, 0) || l.RefillPerSecond <= 0 || l.RefillPerSecond > 1000000 || l.Concurrent < 1 || l.Concurrent > 100000 {
			return errors.New("invalid gateway limits")
		}
	}
	for provider, limit := range a.Config.ProviderTokens {
		if _, ok := a.Config.Provider[provider]; !ok {
			return errors.New("token limit requires provider request limit")
		}
		if limit.Capacity < 1 || limit.Capacity > maxTokenReservation || math.IsNaN(limit.RefillPerSecond) || math.IsInf(limit.RefillPerSecond, 0) || limit.RefillPerSecond <= 0 || limit.RefillPerSecond > float64(maxTokenReservation) || 2*float64(limit.Capacity)*1000/limit.RefillPerSecond > float64(1<<53-1) {
			return errors.New("invalid provider token limits")
		}
	}
	if a.Config.Indexing.Concurrent >= a.Config.Tenant.Concurrent {
		return errors.New("indexing must leave interactive concurrency headroom")
	}
	if time.Duration(a.Config.LeaseSeconds)*time.Second <= total+5*time.Second || a.Config.LeaseSeconds > 300 {
		return errors.New("lease must exceed total request timeout plus cleanup margin")
	}
	return nil
}

// Acquire preserves request-only callers. Configured TPM requires an explicit
// conservative weight; it cannot silently downgrade to request-only admission.
func (a *RedisAdmission) Acquire(ctx context.Context, c Caller, workload, provider, id string) (func(), error) {
	return a.acquire(ctx, c, workload, provider, id, 0)
}
func (a *RedisAdmission) AcquireWeighted(ctx context.Context, c Caller, workload, provider, id string, tokens int64) (func(), error) {
	if tokens < 1 || tokens > maxTokenReservation {
		return nil, &ControlError{"invalid_provider_token_reservation", 503, 1}
	}
	return a.acquire(ctx, c, workload, provider, id, tokens)
}
func (a *RedisAdmission) AcquireRequest(ctx context.Context, c Caller, workload, provider, id, path string, encoded []byte) (func(), error) {
	if _, enabled := a.Config.ProviderTokens[provider]; !enabled {
		return a.Acquire(ctx, c, workload, provider, id)
	}
	tokens, err := estimateProviderTokens(path, encoded)
	if err != nil {
		return nil, &ControlError{"invalid_provider_token_reservation", 503, 1}
	}
	return a.AcquireWeighted(ctx, c, workload, provider, id, tokens)
}
func (a *RedisAdmission) acquire(ctx context.Context, c Caller, workload, provider, id string, tokens int64) (func(), error) {
	providerLimit, ok := a.Config.Provider[provider]
	if !ok {
		return nil, &ControlError{"provider_limit_not_configured", 503, 1}
	}
	tokenLimit, weighted := a.Config.ProviderTokens[provider]
	if weighted && tokens < 1 {
		return nil, &ControlError{"provider_token_reservation_required", 503, 1}
	}
	if weighted && tokens > tokenLimit.Capacity {
		return nil, &ControlError{"provider_token_request_too_large", 429, 1}
	}
	prefix := "ai:rate:{" + c.TenantID + "}:" + provider + ":"
	keys := []string{prefix + "tenant:bucket", prefix + "tenant:leases", prefix + workload + ":bucket", prefix + workload + ":leases"}
	selected := a.Config.Query
	if workload == "indexing" {
		selected = a.Config.Indexing
	}
	limits := []Limit{a.Config.Tenant, selected}
	if c.PrincipalID != "" {
		h := sha256.Sum256([]byte(c.PrincipalID))
		prefix += "user:" + hex.EncodeToString(h[:]) + ":"
		keys = append(keys, prefix+"bucket", prefix+"leases")
		limits = append(limits, a.Config.User)
	}
	args := []any{id, a.Config.LeaseSeconds * 1000}
	for _, l := range limits {
		args = append(args, l.Capacity, l.RefillPerSecond, l.Concurrent, 1)
	}
	reply, err := admissionScript.Run(ctx, a.Client, keys, args...).Int64Slice()
	if err != nil || len(reply) != 2 {
		return nil, &ControlError{"admission_unavailable", 503, 1}
	}
	if reply[0] != 1 {
		return nil, &ControlError{"ai_rate_or_concurrency_limited", 429, int((reply[1] + 999) / 1000)}
	}
	leases := []string{}
	for i := 1; i < len(keys); i += 2 {
		leases = append(leases, keys[i])
	}
	globalKeys := []string{"ai:provider:{" + provider + "}:bucket", "ai:provider:{" + provider + "}:leases"}
	globalArgs := []any{id, a.Config.LeaseSeconds * 1000, providerLimit.Capacity, providerLimit.RefillPerSecond, providerLimit.Concurrent, 1}
	if weighted {
		globalKeys = append(globalKeys, "ai:provider:{"+provider+"}:token_bucket", "ai:provider:{"+provider+"}:token_leases")
		globalArgs = append(globalArgs, tokenLimit.Capacity, tokenLimit.RefillPerSecond, providerLimit.Concurrent, tokens)
	}
	globalReply, globalErr := admissionScript.Run(ctx, a.Client, globalKeys, globalArgs...).Int64Slice()
	if globalErr != nil || len(globalReply) != 2 || globalReply[0] != 1 {
		cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
		_ = releaseScript.Run(cleanup, a.Client, leases, id).Err()
		cancel()
		if globalErr != nil || len(globalReply) != 2 {
			return nil, &ControlError{"admission_unavailable", 503, 1}
		}
		return nil, &ControlError{"provider_rate_or_concurrency_limited", 429, int((globalReply[1] + 999) / 1000)}
	}
	return func() {
		cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = releaseScript.Run(cleanup, a.Client, leases, id).Err()
		globalLeases := []string{globalKeys[1]}
		if weighted {
			globalLeases = append(globalLeases, globalKeys[3])
		}
		_ = releaseScript.Run(cleanup, a.Client, globalLeases, id).Err()
	}, nil
}
func requestID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", b), nil
}

const maxTokenReservation int64 = 1000000000

// estimateProviderTokens uses UTF-8 serialized bytes plus explicit 1024-unit
// overhead, repeated rerank queries and the requested generation output bound.
// This deliberately over-reserves visible input, but hidden provider overhead
// and account/model tokenization still need quota-specific operational tuning.
func estimateProviderTokens(path string, encoded []byte) (int64, error) {
	var payload struct {
		Model     string            `json:"model"`
		MaxTokens int64             `json:"max_tokens"`
		Query     string            `json:"query"`
		Documents []json.RawMessage `json:"documents"`
	}
	if len(encoded) > 4<<20 || json.Unmarshal(encoded, &payload) != nil || payload.Model == "" {
		return 0, errors.New("invalid provider payload")
	}
	tokens := int64(len(encoded)) + 1024
	switch path {
	case "/embeddings":
	case "/rerank":
		tokens += int64(len(payload.Query)) * int64(len(payload.Documents))
	case "/messages", "/chat/completions":
		if payload.MaxTokens < 1 || payload.MaxTokens > 1000000 {
			return 0, errors.New("invalid output reservation")
		}
		tokens += payload.MaxTokens
	default:
		return 0, errors.New("unsupported provider task")
	}
	if tokens < 1 || tokens > maxTokenReservation {
		return 0, errors.New("provider reservation overflow")
	}
	return tokens, nil
}
