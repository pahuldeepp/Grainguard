package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type rlClock struct{ now time.Time }

func (c *rlClock) tick(d time.Duration) { c.now = c.now.Add(d) }
func (c *rlClock) get() time.Time       { return c.now }

func rlLimiter(cfg LimitConfig) (*TokenBuckets, *rlClock) {
	clock := &rlClock{now: time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)}
	return NewTokenBuckets(cfg, clock.get), clock
}

func rlConfig() LimitConfig {
	return LimitConfig{
		Device:     BucketConfig{Rate: 1, Burst: 3},
		Tenant:     BucketConfig{Rate: 100, Burst: 1000},
		MaxEntries: 1000,
	}
}

func TestDefaultLimitConfigMatchesTheCapacityAssumptions(t *testing.T) {
	cfg := DefaultLimitConfig()
	if cfg.Device.Rate != 0.2 || cfg.Device.Burst != 20 || cfg.MaxEntries <= 0 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if NewTokenBuckets(cfg, nil).now == nil {
		t.Fatal("a nil clock must default to time.Now")
	}
}

func TestDeviceBucketAllowsABurstThenThrottlesAndRefills(t *testing.T) {
	limiter, clock := rlLimiter(rlConfig())
	for i := 0; i < 3; i++ {
		if ok, _ := limiter.Allow("t1", "d1"); !ok {
			t.Fatalf("burst request %d refused", i+1)
		}
	}
	ok, wait := limiter.Allow("t1", "d1")
	if ok || wait != time.Second {
		t.Fatalf("4th request: ok=%v wait=%v, want refused and 1s", ok, wait)
	}
	clock.tick(500 * time.Millisecond)
	if ok, wait := limiter.Allow("t1", "d1"); ok || wait != 500*time.Millisecond {
		t.Fatalf("after 0.5s: ok=%v wait=%v", ok, wait)
	}
	clock.tick(500 * time.Millisecond)
	if ok, _ := limiter.Allow("t1", "d1"); !ok {
		t.Fatal("a token must have refilled after the wait")
	}
	clock.tick(time.Hour)
	for i := 0; i < 3; i++ {
		if ok, _ := limiter.Allow("t1", "d1"); !ok {
			t.Fatal("a long idle period refills to the burst, never beyond")
		}
	}
	if ok, _ := limiter.Allow("t1", "d1"); ok {
		t.Fatal("the bucket must never hold more than its burst")
	}
}

func TestOneNoisyDeviceDoesNotThrottleAnother(t *testing.T) {
	limiter, _ := rlLimiter(rlConfig())
	for i := 0; i < 10; i++ {
		limiter.Allow("t1", "noisy")
	}
	if ok, _ := limiter.Allow("t1", "quiet"); !ok {
		t.Fatal("another device must have its own bucket")
	}
	if ok, _ := limiter.Allow("t2", "noisy"); !ok {
		t.Fatal("the same device id in another tenant must have its own bucket")
	}
}

func TestTenantBucketLimitsAllOfATenantsDevicesAndDeniedRequestsConsumeNothing(t *testing.T) {
	cfg := rlConfig()
	cfg.Device = BucketConfig{Rate: 100, Burst: 100}
	cfg.Tenant = BucketConfig{Rate: 2, Burst: 4}
	limiter, clock := rlLimiter(cfg)
	for i, device := range []string{"a", "b", "c", "d"} {
		if ok, _ := limiter.Allow("t1", device); !ok {
			t.Fatalf("request %d across devices refused", i+1)
		}
	}
	ok, wait := limiter.Allow("t1", "e")
	if ok || wait != 500*time.Millisecond {
		t.Fatalf("tenant limit: ok=%v wait=%v", ok, wait)
	}
	if limiter.devices.items["t1/e"].tokens != 100 {
		t.Fatal("a refused request must not consume a device token")
	}
	clock.tick(500 * time.Millisecond)
	if ok, _ := limiter.Allow("t1", "e"); !ok {
		t.Fatal("the tenant bucket must refill")
	}
}

func TestConcurrentRequestsNeverExceedTheBurst(t *testing.T) {
	cfg := rlConfig()
	cfg.Device = BucketConfig{Rate: 0.0001, Burst: 10}
	limiter, _ := rlLimiter(cfg)
	var allowed atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, _ := limiter.Allow("t1", "d1"); ok {
				allowed.Add(1)
			}
		}()
	}
	wg.Wait()
	if allowed.Load() != 10 {
		t.Fatalf("allowed %d of 100 concurrent requests, want exactly the burst of 10", allowed.Load())
	}
}

func TestBucketsBackToFullAreReclaimedWhenTheStoreIsFull(t *testing.T) {
	cfg := rlConfig()
	cfg.MaxEntries = 4
	limiter, clock := rlLimiter(cfg)
	for _, device := range []string{"a", "b", "c", "d"} {
		limiter.Allow("t1", device)
	}
	clock.tick(10 * time.Second)
	if ok, _ := limiter.Allow("t1", "e"); !ok {
		t.Fatal("buckets that refilled to full must be reclaimed to admit a new key")
	}
	if n := len(limiter.devices.items); n > cfg.MaxEntries {
		t.Fatalf("bucket count %d exceeds the cap %d", n, cfg.MaxEntries)
	}
}

func TestMemoryPressureNeverResetsAThrottledDevice(t *testing.T) {
	cfg := rlConfig()
	cfg.MaxEntries = 4
	cfg.Device = BucketConfig{Rate: 0.001, Burst: 2}
	limiter, clock := rlLimiter(cfg)
	limiter.Allow("t1", "noisy")
	limiter.Allow("t1", "noisy")
	if ok, _ := limiter.Allow("t1", "noisy"); ok {
		t.Fatal("the device must be throttled before the store fills")
	}
	for _, device := range []string{"a", "b", "c"} {
		limiter.Allow("t1", device)
	}
	clock.tick(2 * time.Second)
	ok, wait := limiter.Allow("t1", "new-device")
	if ok || wait != refuseWait {
		t.Fatalf("with every bucket still holding a limit a new key is refused: ok=%v wait=%v", ok, wait)
	}
	if ok, _ := limiter.Allow("t1", "noisy"); ok {
		t.Fatal("memory pressure must not hand a throttled device a fresh bucket")
	}
	if n := len(limiter.devices.items); n > cfg.MaxEntries {
		t.Fatalf("bucket count %d exceeds the cap %d", n, cfg.MaxEntries)
	}
}

func TestTheTenantSetRefusesNewTenantsUnderMemoryPressureToo(t *testing.T) {
	cfg := rlConfig()
	cfg.MaxEntries = 2
	cfg.Tenant = BucketConfig{Rate: 0.001, Burst: 5}
	limiter, _ := rlLimiter(cfg)
	limiter.Allow("tenant-a", "d")
	limiter.Allow("tenant-b", "d")
	if ok, wait := limiter.Allow("tenant-c", "d"); ok || wait != refuseWait {
		t.Fatalf("tenant set full of drained buckets: ok=%v wait=%v", ok, wait)
	}
}

func TestUnusableLimitConfigurationFallsBackToTheDefaults(t *testing.T) {
	limiter, _ := rlLimiter(LimitConfig{})
	defaults := DefaultLimitConfig()
	if limiter.devices.cfg != defaults.Device || limiter.tenants.cfg != defaults.Tenant || limiter.devices.max != defaults.MaxEntries {
		t.Fatalf("zero config was not normalised: %+v %+v %d", limiter.devices.cfg, limiter.tenants.cfg, limiter.devices.max)
	}
	for name, cfg := range map[string]BucketConfig{
		"zero rate": {Rate: 0, Burst: 5}, "negative rate": {Rate: -1, Burst: 5},
		"burst below one": {Rate: 1, Burst: 0.5}, "zero burst": {Rate: 1, Burst: 0},
	} {
		got := normalizeLimits(LimitConfig{Device: cfg, Tenant: cfg, MaxEntries: -3})
		if got.Device != defaults.Device || got.Tenant != defaults.Tenant || got.MaxEntries != defaults.MaxEntries {
			t.Errorf("%s: not replaced by defaults: %+v", name, got)
		}
	}
	custom := LimitConfig{Device: BucketConfig{Rate: 2, Burst: 4}, Tenant: BucketConfig{Rate: 3, Burst: 9}, Key: BucketConfig{Rate: 2, Burst: 4}, MaxEntries: 7}
	if normalizeLimits(custom) != custom {
		t.Fatal("a valid configuration must be kept as it is")
	}
}
