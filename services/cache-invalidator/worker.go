package main

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

var errInvalidationUnconfirmed = errors.New("cache invalidation unconfirmed; offset left uncommitted")

// Record is one canonical notification with enough identity to commit its offset.
type Record struct {
	Topic     string
	Partition int32
	Offset    int64
	Value     []byte
}

// Source is the consumer-group seam. Poll returns (nil, nil) when ctx's deadline passes
// with no records; Commit commits the given records' offsets; AllowRebalance releases
// a rebalance blocked while a batch was in flight.
type Source interface {
	Poll(ctx context.Context, max int) ([]Record, error)
	Commit(ctx context.Context, records []Record) error
	AllowRebalance()
}

// Bumper raises a version key to max(current+1, floor). Versions never decrease, so
// duplicate and reordered notifications only cause harmless extra bumps.
type Bumper interface {
	Bump(ctx context.Context, key string, floor int64, ttl time.Duration) error
}

// Settings bound every Redis wait so the consumer never stalls on an outage.
type Settings struct {
	Window        time.Duration // coalescing window started by the first record
	EpochRetry    time.Duration // idle poll interval while an epoch bump is pending
	MaxBatch      int
	Attempts      int
	OpTimeout     time.Duration
	Backoff       time.Duration
	VersionTTL    time.Duration
	Concurrency   int
	CommitTimeout time.Duration
}

// Worker commits offsets only after each bump succeeded or a global epoch bump
// was confirmed. An in-memory pending flag alone cannot authorize a commit.
type Worker struct {
	Source       Source
	Bumper       Bumper
	Metrics      *Metrics
	Settings     Settings
	Now          func() time.Time
	epochPending atomic.Bool
}

func (w *Worker) Run(ctx context.Context) error {
	for {
		b, err := w.collect(ctx)
		if err != nil {
			return err
		}
		for {
			err = w.flush(ctx, b)
			if errors.Is(err, errInvalidationUnconfirmed) {
				w.Metrics.ready.Store(false)
				if !sleep(ctx, w.Settings.EpochRetry) {
					return ctx.Err()
				}
				continue
			}
			if err != nil {
				return err
			}
			w.Metrics.ready.Store(true)
			break
		}
	}
}

// collect blocks for the first record (or the epoch retry interval while an epoch bump is
// pending), then keeps polling until the window closes or the batch is full.
func (w *Worker) collect(ctx context.Context) (*batch, error) {
	b := newBatch()
	first, err := w.pollFor(ctx, w.firstWait(), w.Settings.MaxBatch)
	if err != nil || len(first) == 0 {
		return b, err
	}
	for _, r := range first {
		b.add(r)
	}
	deadline := w.Now().Add(w.Settings.Window)
	for len(b.records) < w.Settings.MaxBatch {
		remaining := deadline.Sub(w.Now())
		if remaining <= 0 {
			break
		}
		more, err := w.pollFor(ctx, remaining, w.Settings.MaxBatch-len(b.records))
		if err != nil {
			return b, err
		}
		for _, r := range more {
			b.add(r)
		}
	}
	return b, nil
}

// firstWait is 0 (block until records or shutdown) unless an epoch bump awaits recovery.
func (w *Worker) firstWait() time.Duration {
	if w.epochPending.Load() {
		return w.Settings.EpochRetry
	}
	return 0
}

func (w *Worker) pollFor(ctx context.Context, wait time.Duration, max int) ([]Record, error) {
	if wait <= 0 {
		return w.Source.Poll(ctx, max)
	}
	pollCtx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	return w.Source.Poll(pollCtx, max)
}

func (w *Worker) flush(ctx context.Context, b *batch) error {
	w.recoverEpoch(ctx)
	targets := b.targets()
	w.bumpAll(ctx, targets)
	if w.epochPending.Load() {
		return errInvalidationUnconfirmed
	}
	w.Metrics.observe(b, len(targets), w.Now())
	if len(b.records) == 0 {
		return nil
	}
	if ctx.Err() != nil {
		// Shutdown interrupted the bumps: leave offsets uncommitted so they replay.
		return ctx.Err()
	}
	commitCtx, cancel := context.WithTimeout(ctx, w.Settings.CommitTimeout)
	defer cancel()
	if err := w.Source.Commit(commitCtx, b.records); err != nil {
		return err
	}
	w.Metrics.commits.Add(1)
	w.Source.AllowRebalance()
	return nil
}

func (w *Worker) queueEpoch() {
	if !w.epochPending.Swap(true) {
		slog.Warn("cache invalidation retry budget exhausted; global epoch bump queued")
	}
	w.Metrics.epochPending.Store(1)
}

// recoverEpoch bumps the global epoch once Redis answers again, so entries written before
// or during the outage (including versions lost in a failover) are never trusted.
func (w *Worker) recoverEpoch(ctx context.Context) {
	if !w.epochPending.Load() {
		return
	}
	if !w.bumpWithRetry(ctx, epochKey, 0) {
		return
	}
	w.epochPending.Store(false)
	w.Metrics.epochPending.Store(0)
	w.Metrics.bumps[scopeEpoch].Add(1)
	slog.Info("global cache epoch bumped after Redis recovery")
}

// bumpAll runs bumps with bounded concurrency. The first exhausted bump queues the
// epoch bump. Once it is pending, remaining bumps are skipped: the epoch bump on
// recovery supersedes every per-key version, so retrying each key against a down
// cluster would only delay the consumer.
func (w *Worker) bumpAll(ctx context.Context, targets []Target) {
	var wg sync.WaitGroup
	slots := make(chan struct{}, w.Settings.Concurrency)
	for _, target := range targets {
		wg.Add(1)
		slots <- struct{}{}
		go func(t Target) {
			defer func() { <-slots; wg.Done() }()
			if w.epochPending.Load() {
				w.Metrics.skipped.Add(1)
				return
			}
			if w.bumpWithRetry(ctx, t.Key(), w.Settings.VersionTTL) {
				w.Metrics.bumps[t.Scope].Add(1)
				return
			}
			w.queueEpoch()
		}(target)
	}
	wg.Wait()
}

func (w *Worker) bumpWithRetry(ctx context.Context, key string, ttl time.Duration) bool {
	for attempt := 1; attempt <= w.Settings.Attempts; attempt++ {
		opCtx, cancel := context.WithTimeout(ctx, w.Settings.OpTimeout)
		err := w.Bumper.Bump(opCtx, key, w.Now().UnixMilli(), ttl)
		cancel()
		if err == nil {
			return true
		}
		w.Metrics.failures.Add(1)
		if attempt == w.Settings.Attempts || !sleep(ctx, w.Settings.Backoff*time.Duration(attempt)) {
			break
		}
	}
	w.Metrics.exhausted.Add(1)
	return false
}

func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
