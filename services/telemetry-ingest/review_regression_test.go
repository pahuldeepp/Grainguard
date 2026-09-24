package main

import (
	"context"
	"crypto/rsa"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

type reviewTransport func(*http.Request) (*http.Response, error)

func (f reviewTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Exercise refresh contention without requiring a listening socket.
func TestReviewRefreshDoesNotLockCachedReaders(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	cache := &jwksCache{url: "https://keys.invalid", maxAge: time.Minute, maxStale: time.Hour,
		cooldown: time.Minute, keys: map[string]*rsa.PublicKey{"known": {E: 65537}}, fetchedAt: time.Now().Add(-2 * time.Minute)}
	cache.client = &http.Client{Transport: reviewTransport(func(*http.Request) (*http.Response, error) {
		close(started)
		<-release
		return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	refreshed := make(chan error, 1)
	go func() { _, err := cache.key("rotated"); refreshed <- err }()
	<-started
	cached := make(chan error, 1)
	go func() { _, err := cache.key("known"); cached <- err }()
	select {
	case err := <-cached:
		if err != nil {
			t.Error(err)
		}
	case <-time.After(time.Second):
		t.Error("cached lookup blocked on refresh")
	}
	close(release)
	if err := <-refreshed; !errors.Is(err, errKeyUnavailable) {
		t.Fatalf("refresh: %v", err)
	}
	_, err := cache.key("rotated")
	authWantCode(t, classifyJWTError(err), 503, codeUnavailable)
}

func TestReviewReceiptPrecedesAgeAndPreservesConflict(t *testing.T) {
	for _, same := range []bool{true, false} {
		steps := ingHappySteps(bindingActive)[:3]
		steps[2] = step{scan: func(d []any) {
			*(d[0].(*[]byte)) = []byte(`{"status":"stored","reading_id":"r","event_id":"e","stream_version":"9","projection_status":"pending"}`)
			*(d[1].(*bool)) = same
		}}
		g := ingScripted(steps)
		g.now = func() time.Time { return ingNow.Add(365 * 24 * time.Hour) }
		result, err := ingScriptedIngest(g)
		if same {
			if err != nil || result.StreamVersion != "9" {
				t.Fatalf("receipt changed: %+v %v", result, err)
			}
		} else {
			ingMustReject(t, err, ReasonIdempotencyConflict, 409)
		}
	}
	g := ingScripted(ingHappySteps(bindingActive)[:3])
	g.now = func() time.Time { return ingNow.Add(365 * 24 * time.Hour) }
	_, err := ingScriptedIngest(g)
	ingMustReject(t, err, ReasonTimestampTooOld, 422)
}

func TestReviewUnknownBindingDoesNotAllocateThrottle(t *testing.T) {
	counter := &ingCounter{}
	r := NewRejectionRecorder(scriptDB{[]step{{rows: 1}, {scan: setBool(false)}}}, counter, nil)
	r.Record(context.Background(), randomUUID(), randomUUID(), ingRejection, nil)
	if len(r.last) != 0 || len(counter.reasons) != 1 {
		t.Fatal("unknown device allocated a throttle entry or lost its counter")
	}
}

func TestReviewColdCacheWaitersShareCompletion(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		done := make(chan struct{})
		cache := &jwksCache{refreshing: done, maxAge: time.Minute, maxStale: time.Hour}
		result := make(chan error, 1)
		go func() { _, err := cache.key("known"); result <- err }()
		synctest.Wait()
		select {
		case <-result:
			t.Fatal("cold caller did not await refresh")
		default:
		}
		cache.mu.Lock()
		cache.keys = map[string]*rsa.PublicKey{"known": {E: 65537}}
		cache.fetchedAt = time.Now()
		cache.refreshing = nil
		close(done)
		cache.mu.Unlock()
		if err := <-result; err != nil {
			t.Fatal(err)
		}
		if _, err := cache.key("known"); err != nil {
			t.Fatal(err)
		}
		cache.fetchedAt = time.Now().Add(-2 * time.Hour)
		if _, err := cache.lookup("known", time.Now()); !errors.Is(err, errKeyUnavailable) {
			t.Fatal(err)
		}
		if _, err := cache.lookup("unknown", time.Now()); !errors.Is(err, errUnknownKey) {
			t.Fatal(err)
		}
	})
}

func TestReviewRefreshRecoveryAndInvalidResponses(t *testing.T) {
	for _, body := range []string{`{"keys":[{"kty":"RSA","kid":"known","n":"AQ","e":"AQAB"}]}`, `{`, `{"keys":[{"kty":"EC","kid":"wrong"}]}`} {
		cache := &jwksCache{url: "https://keys.invalid", maxAge: time.Minute, maxStale: time.Minute}
		cache.client = &http.Client{Transport: reviewTransport(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
		})}
		_, err := cache.key("known")
		if strings.Contains(body, `"kty":"RSA"`) {
			if err != nil {
				t.Fatal(err)
			}
		} else if err == nil {
			t.Fatal("invalid response accepted")
		}
	}
	cache := &jwksCache{url: "https://keys.invalid", client: &http.Client{Transport: reviewTransport(func(*http.Request) (*http.Response, error) { return nil, errBoom })}}
	if _, err := cache.fetch(); !errors.Is(err, errKeyUnavailable) {
		t.Fatal(err)
	}
}
