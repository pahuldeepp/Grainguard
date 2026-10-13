package main

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// workerHealth tracks real runtime signals. Readiness requires an assigned
// result-topic partition and fresh progress from every configured shard loop.
// Liveness only checks loop progress, so a Kafka rebalance removes readiness
// without needlessly restarting a healthy process.
type workerHealth struct {
	mu            sync.RWMutex
	assigned      bool
	loops         map[string]time.Time
	consumerSince time.Time
	requiredLoops int
	staleAfter    time.Duration
}

func newWorkerHealth(requiredLoops int, staleAfter time.Duration) *workerHealth {
	return &workerHealth{loops: make(map[string]time.Time), requiredLoops: requiredLoops, staleAfter: staleAfter}
}

func (h *workerHealth) workerProgress(id string) {
	h.mu.Lock()
	h.loops[id] = time.Now()
	h.mu.Unlock()
}

func assignedPartitions(partitions map[string][]int32) bool {
	for _, ids := range partitions {
		if len(ids) > 0 {
			return true
		}
	}
	return false
}

func (h *workerHealth) setAssigned(partitions map[string][]int32) {
	h.mu.Lock()
	h.assigned = assignedPartitions(partitions)
	h.mu.Unlock()
}

func (h *workerHealth) clearAssignment() {
	h.mu.Lock()
	h.assigned = false
	h.mu.Unlock()
}

func (h *workerHealth) beginConsumerWork() {
	h.mu.Lock()
	h.consumerSince = time.Now()
	h.mu.Unlock()
}

func (h *workerHealth) endConsumerWork() {
	h.mu.Lock()
	h.consumerSince = time.Time{}
	h.mu.Unlock()
}

func (h *workerHealth) consumerGroupOptions() []kgo.Opt {
	return []kgo.Opt{
		kgo.OnPartitionsAssigned(func(_ context.Context, _ *kgo.Client, partitions map[string][]int32) {
			h.setAssigned(partitions)
		}),
		kgo.OnPartitionsRevoked(func(context.Context, *kgo.Client, map[string][]int32) { h.clearAssignment() }),
		kgo.OnPartitionsLost(func(context.Context, *kgo.Client, map[string][]int32) { h.clearAssignment() }),
	}
}

func (h *workerHealth) loopsLive(now time.Time) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.requiredLoops < 1 || len(h.loops) < h.requiredLoops {
		return false
	}
	for _, last := range h.loops {
		if now.Sub(last) > h.staleAfter {
			return false
		}
	}
	if !h.consumerSince.IsZero() && now.Sub(h.consumerSince) > h.staleAfter {
		return false
	}
	return true
}

func (h *workerHealth) live() bool { return h.loopsLive(time.Now()) }

func (h *workerHealth) ready() bool {
	if !h.live() {
		return false
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.assigned
}

func (h *workerHealth) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		if !h.live() {
			http.Error(w, "worker loop progress stale", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !h.ready() {
			http.Error(w, "consumer assignment or worker progress unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

// serveWorkerHealth binds only to the configured address (the chart uses
// loopback) and reports listener failures through the worker's fatal channel.
func serveWorkerHealth(ctx context.Context, addr string, health *workerHealth, errs chan<- error) func() {
	srv := &http.Server{Addr: addr, Handler: health.handler(), ReadHeaderTimeout: 3 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			select {
			case errs <- err:
			case <-ctx.Done():
			}
		}
	}()
	return func() {
		shutdown, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}
}

func probeHealth(path, addr string) error {
	if path != "/healthz" && path != "/readyz" {
		return errors.New("unsupported saga worker probe path")
	}
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://" + addr + path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return errors.New("saga worker health endpoint is unavailable")
	}
	return nil
}
