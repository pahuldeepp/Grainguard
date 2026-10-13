package main

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// The public edge must also rate limit requests by source IP. This local guard is
// a bounded fallback for direct service exposure and limits verifier amplification.
const (
	defaultPreAuthCapacity = 30
	defaultPreAuthRate     = 10.0
	defaultPreAuthPeers    = 4096
	defaultVerifyParallel  = 16
)

type peerBucket struct {
	tokens float64
	last   time.Time
}

type PreAuthGuard struct {
	mu       sync.Mutex
	buckets  map[string]peerBucket
	capacity float64
	rate     float64
	maxPeers int
	now      func() time.Time
	verify   chan struct{}
	trusted  []netip.Prefix
}

func NewPreAuthGuard(trustedProxyCIDRs ...netip.Prefix) *PreAuthGuard {
	return newPreAuthGuard(defaultPreAuthCapacity, defaultPreAuthRate, defaultPreAuthPeers, defaultVerifyParallel, time.Now, trustedProxyCIDRs...)
}

func newPreAuthGuard(capacity int, rate float64, maxPeers, verifyParallel int, now func() time.Time, trustedProxyCIDRs ...netip.Prefix) *PreAuthGuard {
	if capacity < 1 {
		capacity = defaultPreAuthCapacity
	}
	if rate <= 0 {
		rate = defaultPreAuthRate
	}
	if maxPeers < 1 {
		maxPeers = defaultPreAuthPeers
	}
	if verifyParallel < 1 {
		verifyParallel = defaultVerifyParallel
	}
	if now == nil {
		now = time.Now
	}
	return &PreAuthGuard{buckets: make(map[string]peerBucket), capacity: float64(capacity), rate: rate,
		maxPeers: maxPeers, now: now, verify: make(chan struct{}, verifyParallel), trusted: trustedProxyCIDRs}
}

// Allow uses the TCP socket peer only. Forwarding headers are supplied by the
// caller and cannot safely establish identity without an explicit trusted-proxy chain.
func (g *PreAuthGuard) Allow(r *http.Request) bool {
	peer := g.requestPeer(r)
	now := g.now()
	g.mu.Lock()
	defer g.mu.Unlock()
	b, ok := g.buckets[peer]
	if !ok {
		if len(g.buckets) >= g.maxPeers {
			// Reclaim only full buckets, so eviction cannot erase a remembered limit.
			for key, candidate := range g.buckets {
				refilled := min(g.capacity, candidate.tokens+now.Sub(candidate.last).Seconds()*g.rate)
				if refilled >= g.capacity {
					delete(g.buckets, key)
					break
				}
			}
			if len(g.buckets) >= g.maxPeers {
				return false
			}
		}
		b = peerBucket{tokens: g.capacity, last: now}
	}
	b.tokens = min(g.capacity, b.tokens+now.Sub(b.last).Seconds()*g.rate)
	b.last = now
	if b.tokens < 1 {
		g.buckets[peer] = b
		return false
	}
	b.tokens--
	g.buckets[peer] = b
	return true
}

func (g *PreAuthGuard) requestPeer(r *http.Request) string {
	socketAddr, socketOK := parsePeerAddr(r.RemoteAddr)
	if !socketOK {
		return r.RemoteAddr
	}
	if !g.isTrusted(socketAddr) {
		return socketAddr.String()
	}
	values := r.Header.Values("X-Forwarded-For")
	if len(values) == 0 {
		return socketAddr.String()
	}
	chain := make([]netip.Addr, 0, len(values)+1)
	for _, value := range values {
		for _, raw := range strings.Split(value, ",") {
			addr, err := netip.ParseAddr(strings.TrimSpace(raw))
			if err != nil {
				return socketAddr.String()
			}
			chain = append(chain, addr.Unmap())
		}
	}
	// Walk from the socket peer toward the client while each hop is trusted.
	// The first untrusted address is the source; entries to its left are ignored.
	client := socketAddr
	for i := len(chain) - 1; i >= 0; i-- {
		client = chain[i]
		if !g.isTrusted(client) {
			break
		}
	}
	return client.String()
}

func (g *PreAuthGuard) isTrusted(addr netip.Addr) bool {
	for _, prefix := range g.trusted {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func parsePeerAddr(remoteAddr string) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return netip.Addr{}, false
	}
	addr, err := netip.ParseAddr(strings.Trim(host, "[]"))
	if err != nil {
		return netip.Addr{}, false
	}
	return addr.Unmap(), true
}

func (g *PreAuthGuard) AcquireVerification() bool {
	select {
	case g.verify <- struct{}{}:
		return true
	default:
		return false
	}
}

func (g *PreAuthGuard) ReleaseVerification() { <-g.verify }

func socketPeer(remoteAddr string) string {
	if addr, ok := parsePeerAddr(remoteAddr); ok {
		return addr.String()
	}
	// RemoteAddr is created by net/http from the socket. Keep malformed test or
	// platform values in one bucket rather than accepting any request header.
	return remoteAddr
}

func (g *PreAuthGuard) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !g.Allow(r) {
			writeProblem(w, r, http.StatusTooManyRequests, "rate_limited", "Too many requests; retry later.", headerRetryAfter, "1")
			return
		}
		next.ServeHTTP(w, r)
	})
}
