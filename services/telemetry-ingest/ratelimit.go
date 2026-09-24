package main

import (
	"math"
	"sync"
	"time"
)

// Limiter decides whether one more reading may be processed for a device of a tenant.
// It runs after authentication, so both identifiers are verified.
type Limiter interface {
	Allow(tenantID, deviceID string) (allowed bool, retryAfter time.Duration)
}

// BucketConfig is a token bucket: Rate tokens per second up to Burst.
type BucketConfig struct {
	Rate  float64
	Burst float64
}

type LimitConfig struct {
	Device, Tenant BucketConfig
	MaxEntries     int
}

// DefaultLimitConfig assumes about one reading per minute per device, with room for a
// reconnecting device to upload a backlog of 20.
func DefaultLimitConfig() LimitConfig {
	return LimitConfig{
		Device:     BucketConfig{Rate: 0.2, Burst: 20},
		Tenant:     BucketConfig{Rate: 200, Burst: 2000},
		MaxEntries: 100000,
	}
}

// valid reports whether a bucket can ever admit a request and can compute a wait time.
func (c BucketConfig) valid() bool { return c.Rate > 0 && c.Burst >= 1 }

// normalizeLimits replaces unusable values with the defaults, so a zero rate can never divide
// by zero and a zero size can never leave the bucket map unbounded.
func normalizeLimits(cfg LimitConfig) LimitConfig {
	defaults := DefaultLimitConfig()
	if !cfg.Device.valid() {
		cfg.Device = defaults.Device
	}
	if !cfg.Tenant.valid() {
		cfg.Tenant = defaults.Tenant
	}
	if cfg.MaxEntries <= 0 {
		cfg.MaxEntries = defaults.MaxEntries
	}
	return cfg
}

const (
	sweepInterval = time.Second
	// refuseWait is what a caller is told when memory pressure prevents tracking a new key.
	refuseWait = time.Second
)

type bucket struct {
	tokens float64
	last   time.Time
}

func (b *bucket) refill(cfg BucketConfig, now time.Time) {
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = math.Min(cfg.Burst, b.tokens+elapsed*cfg.Rate)
	}
	b.last = now
}

func (b *bucket) wait(cfg BucketConfig) time.Duration {
	if b.tokens >= 1 {
		return 0
	}
	return time.Duration(math.Ceil((1 - b.tokens) / cfg.Rate * float64(time.Second)))
}

// bucketSet holds the buckets for one key space and keeps its size bounded. A bucket that is
// back to full is indistinguishable from a new one, so those are reclaimed first. A bucket
// that still remembers a limit is never dropped: when the set is full of such buckets a new
// key is refused instead, so memory pressure can never reset a throttled key.
type bucketSet struct {
	cfg       BucketConfig
	max       int
	items     map[string]*bucket
	lastSweep time.Time
}

func (s *bucketSet) get(key string, now time.Time) (*bucket, bool) {
	b, ok := s.items[key]
	if !ok {
		if !s.makeRoom(now) {
			return nil, false
		}
		b = &bucket{tokens: s.cfg.Burst, last: now}
		s.items[key] = b
	}
	b.refill(s.cfg, now)
	return b, true
}

func (s *bucketSet) makeRoom(now time.Time) bool {
	if len(s.items) < s.max {
		return true
	}
	if now.Sub(s.lastSweep) >= sweepInterval {
		for key, b := range s.items {
			b.refill(s.cfg, now)
			if b.tokens >= s.cfg.Burst {
				delete(s.items, key)
			}
		}
		s.lastSweep = now
	}
	return len(s.items) < s.max
}

// TokenBuckets is an in-process Limiter: one bucket per device and one per tenant. A request
// needs a token from both; a denied request consumes nothing.
type TokenBuckets struct {
	now     func() time.Time
	mu      sync.Mutex
	devices *bucketSet
	tenants *bucketSet
}

func NewTokenBuckets(cfg LimitConfig, now func() time.Time) *TokenBuckets {
	if now == nil {
		now = time.Now
	}
	cfg = normalizeLimits(cfg)
	newSet := func(c BucketConfig) *bucketSet {
		return &bucketSet{cfg: c, max: cfg.MaxEntries, items: make(map[string]*bucket)}
	}
	return &TokenBuckets{now: now, devices: newSet(cfg.Device), tenants: newSet(cfg.Tenant)}
}

func (t *TokenBuckets) Allow(tenantID, deviceID string) (bool, time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	device, deviceOK := t.devices.get(tenantID+"/"+deviceID, now)
	tenant, tenantOK := t.tenants.get(tenantID, now)
	if !deviceOK || !tenantOK {
		return false, refuseWait
	}
	if wait := max(device.wait(t.devices.cfg), tenant.wait(t.tenants.cfg)); wait > 0 {
		return false, wait
	}
	device.tokens--
	tenant.tokens--
	return true, 0
}
