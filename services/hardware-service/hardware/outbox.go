package hardware

import (
	"context"
	"encoding/json"
	transport "greenguard.local/kafka-transport"
	"time"
)

type OutboxPublisher struct {
	Store        Store
	Client       transport.Client
	PollInterval time.Duration
}

func (p OutboxPublisher) Run(ctx context.Context) error {
	interval := p.PollInterval
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := p.PublishPending(ctx); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
func (p OutboxPublisher) PublishPending(ctx context.Context) error {
	results, err := p.Store.UnpublishedResults(ctx)
	if err != nil {
		return err
	}
	for _, r := range results {
		data, err := json.Marshal(r)
		if err != nil {
			return err
		}
		if err = transport.Publish(ctx, p.Client, ResultTopic, []byte(r.TenantID+":"+r.SagaID), data, resultHeaders(r)); err != nil {
			return err
		}
		if err = p.Store.MarkPublished(ctx, r); err != nil {
			return err
		}
	}
	return nil
}

// resultHeaders propagates the saga's stored trace context (echoed from the
// command, ADR-0004 Saga section) and correlation ID. A result without a
// stored context carries no traceparent rather than an invented one.
func resultHeaders(r Result) map[string]string {
	h := map[string]string{"tenant_id": r.TenantID, "saga_id": r.SagaID, "correlation_id": r.SagaID}
	if r.Traceparent != "" {
		h["traceparent"] = r.Traceparent
	}
	return h
}
