package main

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestPreAuthGuardUsesSocketPeerAndBoundsCardinality(t *testing.T) {
	now := time.Unix(100, 0)
	g := newPreAuthGuard(1, 1, 1, 1, func() time.Time { return now })
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.RemoteAddr = "192.0.2.10:1234"
	r.Header.Set("X-Forwarded-For", "198.51.100.1")
	if !g.Allow(r) {
		t.Fatal("first request should be admitted")
	}
	r.Header.Set("X-Forwarded-For", "203.0.113.99")
	if g.Allow(r) {
		t.Fatal("X-Forwarded-For must not rotate the socket-peer bucket")
	}
	other := httptest.NewRequest(http.MethodPost, "/", nil)
	other.RemoteAddr = "192.0.2.11:1234"
	if g.Allow(other) {
		t.Fatal("new peer must be refused while the bounded map is full")
	}
	if got := len(g.buckets); got != 1 {
		t.Fatalf("bucket map size = %d, want <= 1", got)
	}
	now = now.Add(time.Second)
	if !g.Allow(other) {
		t.Fatal("full bucket should be reclaimable after refill")
	}
	if got := len(g.buckets); got != 1 {
		t.Fatalf("bucket map size after reclaim = %d, want <= 1", got)
	}
}

func TestPreAuthGuardTrustedProxyResolution(t *testing.T) {
	proxyCIDR := netip.MustParsePrefix("10.0.0.0/8")
	tests := []struct {
		name, remote, forwarded string
		trusted                 []netip.Prefix
		want                    string
	}{
		{name: "untrusted spoof is ignored", remote: "192.0.2.4:1234", forwarded: "198.51.100.9", trusted: []netip.Prefix{proxyCIDR}, want: "192.0.2.4"},
		{name: "trusted proxy chain selects nearest untrusted hop", remote: "10.0.0.3:1234", forwarded: "198.51.100.7, 10.0.0.2", trusted: []netip.Prefix{proxyCIDR}, want: "198.51.100.7"},
		{name: "malformed chain falls back to proxy peer", remote: "10.0.0.3:1234", forwarded: "198.51.100.7, not-an-ip", trusted: []netip.Prefix{proxyCIDR}, want: "10.0.0.3"},
		{name: "direct peer mode ignores forwarding headers", remote: "192.0.2.8:1234", forwarded: "198.51.100.9", want: "192.0.2.8"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			g := newPreAuthGuard(10, 1, 10, 1, time.Now, tc.trusted...)
			r := httptest.NewRequest(http.MethodPost, "/", nil)
			r.RemoteAddr = tc.remote
			r.Header.Set("X-Forwarded-For", tc.forwarded)
			if got := g.requestPeer(r); got != tc.want {
				t.Fatalf("request peer = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestPreAuthGuardChargesResolvedPeerBuckets(t *testing.T) {
	proxyCIDR := netip.MustParsePrefix("10.0.0.0/8")
	tests := []struct {
		name     string
		trusted  []netip.Prefix
		requests []struct{ remote, forwarded string }
	}{
		{
			name:    "same client through a multihop trusted chain shares one bucket",
			trusted: []netip.Prefix{proxyCIDR},
			requests: []struct{ remote, forwarded string }{
				{remote: "10.0.0.3:1234", forwarded: "198.51.100.7, 10.0.0.2"},
				{remote: "10.0.0.4:1234", forwarded: "198.51.100.7, 10.0.0.1"},
			},
		},
		{
			name:    "untrusted source cannot rotate its bucket with spoofed forwarding",
			trusted: []netip.Prefix{proxyCIDR},
			requests: []struct{ remote, forwarded string }{
				{remote: "192.0.2.4:1234", forwarded: "198.51.100.7"},
				{remote: "192.0.2.4:1234", forwarded: "203.0.113.8"},
			},
		},
		{
			name:    "malformed chain charges socket peer bucket",
			trusted: []netip.Prefix{proxyCIDR},
			requests: []struct{ remote, forwarded string }{
				{remote: "10.0.0.3:1234", forwarded: "198.51.100.7, malformed"},
				{remote: "10.0.0.3:1234", forwarded: "also-malformed"},
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			g := newPreAuthGuard(1, 1, 8, 1, time.Now, tc.trusted...)
			for i, request := range tc.requests {
				r := httptest.NewRequest(http.MethodPost, "/", nil)
				r.RemoteAddr = request.remote
				r.Header.Set("X-Forwarded-For", request.forwarded)
				if got := g.Allow(r); got != (i == 0) {
					t.Fatalf("Allow request %d = %v, want %v", i+1, got, i == 0)
				}
			}
		})
	}
}

func TestPreAuthSaturationBoundsAPIKeyAndM2MVerifierCalls(t *testing.T) {
	for _, tc := range []struct{ name, authorization, path string }{
		{name: "api-key", authorization: "Bearer gg_arbitrary", path: "/v1/internal/credentials/api-key/verify"},
		{name: "m2m", authorization: "Bearer " + m2mShapeToken(), path: "/v1/internal/credentials/oauth-token/verify"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var inFlight, maxInFlight, calls atomic.Int32
			entered := make(chan struct{}, 16)
			release := make(chan struct{})
			var releaseOnce sync.Once
			releaseVerifier := func() { releaseOnce.Do(func() { close(release) }) }
			defer releaseVerifier()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tc.path {
					t.Errorf("verifier path = %s", r.URL.Path)
				}
				calls.Add(1)
				n := inFlight.Add(1)
				for old := maxInFlight.Load(); n > old && !maxInFlight.CompareAndSwap(old, n); old = maxInFlight.Load() {
				}
				entered <- struct{}{}
				<-release
				inFlight.Add(-1)
				w.WriteHeader(http.StatusUnauthorized)
			}))
			defer srv.Close()
			v, err := NewAPIKeyVerifier(srv.URL, "lookup")
			if err != nil {
				t.Fatal(err)
			}
			v.Client = srv.Client()
			verifier, err := NewVerifier(AuthConfig{Issuer: "https://issuer.test", Audience: "test", Keyfunc: func(_ *jwt.Token) (any, error) { return nil, nil }})
			if err != nil {
				t.Fatal(err)
			}
			guard := newPreAuthGuard(32, 32, 8, 2, time.Now)
			app := App{Verifier: verifier, APIKeys: v, PreAuth: guard}
			handler := newHandler(app)
			const requestCount = 12
			var wg sync.WaitGroup
			statuses := make(chan int, requestCount)
			start := make(chan struct{})
			for i := 0; i < requestCount; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					r := httptest.NewRequest(http.MethodPost, "/v1/devices/00000000-0000-4000-8000-000000000001/readings", nil)
					r.Header.Set("Authorization", tc.authorization)
					r.RemoteAddr = "192.0.2.50:4321"
					<-start
					w := httptest.NewRecorder()
					handler.ServeHTTP(w, r)
					statuses <- w.Code
				}()
			}
			close(start)
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("no control-plane verification entered")
			}
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("second control-plane slot was not used")
			}
			// Hold both slots until every overflow response has returned.
			initial := make([]int, 0, requestCount-2)
			for got429 := 0; got429 < requestCount-2; {
				select {
				case status := <-statuses:
					initial = append(initial, status)
					if status == http.StatusTooManyRequests {
						got429++
					}
				case <-time.After(3 * time.Second):
					releaseVerifier()
					t.Fatalf("received %d overflow responses while verifier slots were blocked", got429)
				}
			}
			releaseVerifier()
			wg.Wait()
			close(statuses)
			got429, gotAuthFailure := 0, 0
			for _, status := range initial {
				if status == http.StatusTooManyRequests {
					got429++
				} else if status == http.StatusUnauthorized || status == http.StatusServiceUnavailable {
					gotAuthFailure++
				} else {
					t.Errorf("unexpected status %d", status)
				}
			}
			for status := range statuses {
				switch status {
				case http.StatusTooManyRequests:
					got429++
				case http.StatusUnauthorized, http.StatusServiceUnavailable:
					gotAuthFailure++
				default:
					t.Errorf("unexpected status %d", status)
				}
			}
			if got := maxInFlight.Load(); got > 2 {
				t.Fatalf("max concurrent verifier calls = %d, want <= 2", got)
			}
			if got := calls.Load(); got > 2 {
				t.Fatalf("verifier calls = %d, want <= 2", got)
			}
			if got429 < requestCount-2 {
				t.Fatalf("429 responses = %d, want at least %d", got429, requestCount-2)
			}
			if gotAuthFailure != 2 {
				t.Fatalf("verifier failures = %d, want 2", gotAuthFailure)
			}
		})
	}
}

func TestPreAuthSaturationBoundsRegularJWTVerifierCalls(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	claims := jwt.MapClaims{
		"iss": "https://issuer.test", "aud": "test", "exp": time.Now().Add(time.Hour).Unix(),
		"sub": "principal", "tenant_id": "00000000-0000-4000-8000-000000000002", "roles": []string{"operator"},
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	const limit = 2
	var inFlight, maxInFlight, calls atomic.Int32
	entered := make(chan struct{}, 16)
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseVerifier := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseVerifier()
	verifier, err := NewVerifier(AuthConfig{
		Issuer: "https://issuer.test", Audience: "test",
		Keyfunc: func(_ *jwt.Token) (any, error) {
			calls.Add(1)
			n := inFlight.Add(1)
			for old := maxInFlight.Load(); n > old && !maxInFlight.CompareAndSwap(old, n); old = maxInFlight.Load() {
			}
			entered <- struct{}{}
			<-release
			inFlight.Add(-1)
			return nil, errUnknownKey
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := newHandler(App{Verifier: verifier, PreAuth: newPreAuthGuard(32, 32, 8, limit, time.Now)})
	const requestCount = 12
	var wg sync.WaitGroup
	statuses := make(chan int, requestCount)
	start := make(chan struct{})
	for i := 0; i < requestCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := httptest.NewRequest(http.MethodPost, "/v1/devices/00000000-0000-4000-8000-000000000001/readings", nil)
			r.Header.Set("Authorization", "Bearer "+token)
			r.RemoteAddr = "192.0.2.51:4321"
			<-start
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			statuses <- w.Code
		}()
	}
	close(start)
	for i := 0; i < limit; i++ {
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			t.Fatal("JWT verification did not fill the concurrency cap")
		}
	}
	initial := make([]int, 0, requestCount-limit)
	for got429 := 0; got429 < requestCount-limit; {
		select {
		case status := <-statuses:
			initial = append(initial, status)
			if status == http.StatusTooManyRequests {
				got429++
			}
		case <-time.After(3 * time.Second):
			releaseVerifier()
			t.Fatalf("received %d JWT overflow responses while verifier slots were blocked", got429)
		}
	}
	releaseVerifier()
	wg.Wait()
	close(statuses)
	got429, gotAuthFailure := 0, 0
	for _, status := range initial {
		if status == http.StatusTooManyRequests {
			got429++
		} else if status == http.StatusUnauthorized {
			gotAuthFailure++
		} else {
			t.Errorf("unexpected initial JWT status %d", status)
		}
	}
	for status := range statuses {
		switch status {
		case http.StatusTooManyRequests:
			got429++
		case http.StatusUnauthorized:
			gotAuthFailure++
		default:
			t.Errorf("unexpected JWT status %d", status)
		}
	}
	if got := maxInFlight.Load(); got > limit {
		t.Fatalf("max concurrent JWT verifier calls = %d, want <= %d", got, limit)
	}
	if got := calls.Load(); got != limit {
		t.Fatalf("JWT key verification calls = %d, want %d", got, limit)
	}
	if got429 != requestCount-limit {
		t.Fatalf("JWT 429 responses = %d, want %d", got429, requestCount-limit)
	}
	if gotAuthFailure != limit {
		t.Fatalf("JWT auth failures = %d, want %d", gotAuthFailure, limit)
	}
}

func m2mShapeToken() string {
	payload, _ := json.Marshal(map[string]string{"gty": "client-credentials"})
	return "e30." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}
