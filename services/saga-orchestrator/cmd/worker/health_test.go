package main

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestWorkerHealthRequiresLiveLoopsAndConsumerAssignment(t *testing.T) {
	now := time.Now()
	h := newWorkerHealth(2, time.Minute)
	h.workerProgress("s1")
	h.workerProgress("s2")
	if !h.live() || h.ready() {
		t.Fatalf("live=%v ready=%v before assignment", h.live(), h.ready())
	}
	h.setAssigned(map[string][]int32{"greenguard.saga.results.v1": {0}})
	if !h.ready() {
		t.Fatal("fresh worker loops and a result partition should be ready")
	}
	h.clearAssignment()
	if h.ready() || !h.live() {
		t.Fatalf("rebalance should clear readiness but retain liveness: live=%v ready=%v", h.live(), h.ready())
	}
	h.mu.Lock()
	h.loops["s2"] = now.Add(-2 * time.Minute)
	h.mu.Unlock()
	if h.live() || h.ready() {
		t.Fatalf("stale shard loop remained healthy: live=%v ready=%v", h.live(), h.ready())
	}
}

func TestWorkerHealthDoesNotAcceptEmptyPartitionAssignment(t *testing.T) {
	h := newWorkerHealth(1, time.Minute)
	h.workerProgress("legacy")
	h.setAssigned(map[string][]int32{"greenguard.saga.results.v1": {}})
	if h.ready() {
		t.Fatal("empty assignment must not make consumer ready")
	}
}

func TestWorkerHealthEndpointsSeparateLivenessFromReadiness(t *testing.T) {
	h := newWorkerHealth(1, time.Minute)
	h.workerProgress("legacy")
	handler := h.handler()

	live := httptest.NewRecorder()
	handler.ServeHTTP(live, httptest.NewRequest("GET", "/healthz", nil))
	if live.Code != 204 {
		t.Fatalf("liveness status=%d body=%s", live.Code, live.Body.String())
	}
	ready := httptest.NewRecorder()
	handler.ServeHTTP(ready, httptest.NewRequest("GET", "/readyz", nil))
	if ready.Code != 503 {
		t.Fatalf("readiness status=%d body=%s", ready.Code, ready.Body.String())
	}
	h.setAssigned(map[string][]int32{"greenguard.saga.results.v1": {0}})
	ready = httptest.NewRecorder()
	handler.ServeHTTP(ready, httptest.NewRequest("GET", "/readyz", nil))
	if ready.Code != 204 {
		t.Fatalf("readiness status=%d body=%s", ready.Code, ready.Body.String())
	}
}
