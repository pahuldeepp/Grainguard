package modelgateway

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"math/rand/v2"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type Price struct {
	InputMicrosPerMillion  int64 `json:"input_micros_per_million"`
	OutputMicrosPerMillion int64 `json:"output_micros_per_million"`
}
type ProductionControls struct {
	Admission        *RedisAdmission
	Budget           BudgetStore
	Prices           map[string]Price
	Attempts         int
	AttemptTimeout   time.Duration
	TotalTimeout     time.Duration
	BreakerThreshold int
	BreakerCooldown  time.Duration
	// Fallbacks map a provider model to an explicitly permitted model of the same
	// protocol. Embedding fallback is deliberately prohibited: index compatibility.
	Fallbacks map[string]string
}
type breakerState struct {
	failures int
	until    time.Time
	probe    bool
}
type circuitBreaker struct {
	mu     sync.Mutex
	states map[string]*breakerState
}

func (b *circuitBreaker) allow(key string, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.states[key]
	if st == nil {
		return true
	}
	if !st.until.IsZero() {
		if now.Before(st.until) || st.probe {
			return false
		}
		st.probe = true
	}
	return true
}
func (b *circuitBreaker) finish(key string, failed bool, threshold int, cooldown time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.states[key]
	if st == nil {
		st = &breakerState{}
		b.states[key] = st
	}
	if !failed {
		delete(b.states, key)
		return
	}
	st.failures++
	if st.probe || st.failures >= threshold {
		st.until = time.Now().Add(cooldown)
	}
	st.probe = false
}
func (c *ProductionControls) validate() error {
	if c == nil {
		return nil
	}
	if c.Attempts < 1 || c.Attempts > 3 || c.AttemptTimeout <= 0 || c.TotalTimeout <= 0 || c.TotalTimeout > 120*time.Second || c.AttemptTimeout > c.TotalTimeout || c.BreakerThreshold < 1 || c.BreakerCooldown < time.Second || c.BreakerCooldown > 5*time.Minute || c.Budget == nil || len(c.Prices) == 0 {
		return errors.New("invalid production controls")
	}
	if err := c.Admission.Validate(c.TotalTimeout); err != nil {
		return err
	}
	for model, p := range c.Prices {
		if model == "" || p.InputMicrosPerMillion < 1 || p.InputMicrosPerMillion > 1000000000 || p.OutputMicrosPerMillion < 0 || p.OutputMicrosPerMillion > 1000000000 {
			return errors.New("invalid model prices")
		}
	}
	for from, to := range c.Fallbacks {
		if from == to || c.Prices[to].InputMicrosPerMillion == 0 || c.Prices[from].InputMicrosPerMillion == 0 {
			return errors.New("invalid fallback")
		}
	}
	return nil
}
func cost(tokens, output int64, p Price) int64 {
	return (tokens*p.InputMicrosPerMillion + output*p.OutputMicrosPerMillion + 999999) / 1000000
}
func retryDelay(attempt int, header string) time.Duration {
	delay := time.Duration(100*(1<<attempt))*time.Millisecond + time.Duration(rand.IntN(100))*time.Millisecond
	if seconds, err := strconv.Atoi(header); err == nil && seconds >= 0 {
		if seconds > 3600 {
			seconds = 3600
		}
		d := time.Duration(seconds) * time.Second
		if d > delay {
			delay = d
		}
	} else if when, err := http.ParseTime(header); err == nil && time.Until(when) > delay {
		delay = time.Until(when)
	}
	if delay > time.Hour {
		delay = time.Hour
	}
	return delay
}
func waitRetry(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
func measuredUsage(raw []byte, anthropic bool) (int64, int64, bool) {
	var envelope struct {
		Usage struct {
			Input      *int64 `json:"input_tokens"`
			Output     *int64 `json:"output_tokens"`
			Total      *int64 `json:"total_tokens"`
			Prompt     *int64 `json:"prompt_tokens"`
			Completion *int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return 0, 0, false
	}
	u := envelope.Usage
	if anthropic && u.Input != nil && u.Output != nil && *u.Input >= 0 && *u.Output >= 0 {
		creation, read, valid := cachedTokenUsage(raw)
		if !valid || creation > math.MaxInt64-*u.Input || read > math.MaxInt64-*u.Input-creation {
			return 0, 0, false
		}
		return *u.Input + creation + read, *u.Output, true
	}
	if u.Prompt != nil && u.Completion != nil && *u.Prompt >= 0 && *u.Completion >= 0 {
		return *u.Prompt, *u.Completion, true
	}
	if u.Total != nil && *u.Total >= 0 {
		return *u.Total, 0, true
	}
	return 0, 0, false
}

func (b *circuitBreaker) abandon(key string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if st := b.states[key]; st != nil {
		st.probe = false
	}
}
