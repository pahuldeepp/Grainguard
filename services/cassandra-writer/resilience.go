package main

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"time"
)

// defaultMaxBackoff caps the outage wait between whole-record attempts.
const defaultMaxBackoff = 30 * time.Second

// backoffDelay is bounded exponential backoff with equal jitter: the wait for
// attempt n (from 0) is uniformly distributed in [d/2, d] where
// d = min(maxDelay, base*2^n). Jitter spreads reconnects from many workers.
func backoffDelay(base, maxDelay time.Duration, attempt int, jitter func(int64) int64) time.Duration {
	if base <= 0 {
		base = time.Millisecond
	}
	if maxDelay < base {
		maxDelay = base
	}
	d := base
	for i := 0; i < attempt && d < maxDelay; i++ {
		d *= 2
	}
	d = min(d, maxDelay)
	half := int64(d / 2)
	return time.Duration(half + jitter(half+1))
}

func jitterN(n int64) int64 { return rand.Int64N(n) }

func sleepCtx(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// unavailable reports whether err means Cassandra (or the per-record work
// deadline it caused) is temporarily unavailable. Those errors never stop the
// worker; anything else still does, holding the uncommitted offset for repair.
func (p *Processor) unavailable(parent context.Context, err error) bool {
	if parent.Err() != nil || p.Transient == nil {
		return false
	}
	return p.Transient(err) || errors.Is(err, context.DeadlineExceeded)
}

func (p *Processor) maxBackoff() time.Duration {
	if p.MaxBackoff > 0 {
		return p.MaxBackoff
	}
	return defaultMaxBackoff
}

func (p *Processor) jitter() func(int64) int64 {
	if p.Jitter != nil {
		return p.Jitter
	}
	return jitterN
}

// degrade marks the worker not ready and starts the outage clock once.
func (p *Processor) degrade(err error, attempt int, wait time.Duration) {
	p.Ready.Store(false)
	if p.Degraded.CompareAndSwap(false, true) {
		p.OutageStarted.Store(time.Now().UnixNano())
		p.Outages.Add(1)
	}
	slog.Warn("cassandra unavailable; holding offset", "attempt", attempt, "retry_in", wait.String(), "error", err)
}

func (p *Processor) restore() {
	if p.Degraded.CompareAndSwap(true, false) {
		slog.Info("cassandra available again", "outage", time.Since(time.Unix(0, p.OutageStarted.Load())).String())
		p.OutageStarted.Store(0)
	}
}

// until repeats fn while Cassandra is unavailable, with jittered backoff. It
// returns nil on success, the parent's error on shutdown, or a fatal error.
func (p *Processor) until(ctx context.Context, fn func(context.Context) error) error {
	for attempt := 0; ; attempt++ {
		err := fn(ctx)
		if err == nil {
			p.restore()
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !p.unavailable(ctx, err) {
			return err
		}
		wait := backoffDelay(p.RetryDelay, p.maxBackoff(), attempt, p.jitter())
		p.degrade(err, attempt, wait)
		if err := sleepCtx(ctx, wait); err != nil {
			return err
		}
	}
}

// outageSeconds is the current outage duration, zero when healthy.
func (p *Processor) outageSeconds() float64 {
	start := p.OutageStarted.Load()
	if start == 0 {
		return 0
	}
	return time.Since(time.Unix(0, start)).Seconds()
}
