package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	transport "greenguard.local/kafka-transport"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"greenguard.local/cassandra-writer/history"
)

// Message is one fetched record with a commit hook for exactly its offset.
type Message = transport.Message

// Record is an outbound quarantine record.
type Record = transport.Record

const maxQuarantineRawBytes = 65536

var errQuarantinePayloadTooLarge = errors.New("quarantine payload exceeds full-preservation limit")

type Source interface {
	Next(context.Context) (Message, error)
}
type Sink interface {
	Publish(context.Context, Record) error
}

// Writer persists history and its confirmation watermark.
type Writer interface {
	Write(context.Context, history.Reading) error
	Confirm(context.Context, history.Watermark) error
}

// Processor applies one record at a time: write, confirm, then commit. It
// never commits an offset before Cassandra acknowledged the write or the
// quarantine record was acknowledged by Kafka.
type Processor struct {
	Tracer                             trace.Tracer
	Source                             Source
	Sink                               Sink
	Schema                             Validator
	Store                              Writer
	Transient, Rejected                func(error) bool
	Attempts                           int
	RetryDelay, ProcessTimeout         time.Duration
	Ready                              atomic.Bool
	Written, Quarantined, Retries, Lag atomic.Uint64
	LastWritten                        atomic.Int64
	Pending                            atomic.Int64
	// Connect, when set, must succeed before consuming; it is retried with
	// backoff so a worker that starts while Cassandra is down waits.
	Connect    func() error
	MaxBackoff time.Duration
	Jitter     func(int64) int64
	Degraded   atomic.Bool
	Outages    atomic.Uint64
	// OutageStarted is the Unix-nano start of the current outage, or zero.
	OutageStarted atomic.Int64
}

// Run consumes until shutdown or a genuinely unrecoverable error. A Cassandra
// outage never ends it: the same record is retried with backoff and its offset
// stays uncommitted, so nothing is skipped or lost.
func (p *Processor) Run(ctx context.Context) error {
	defer p.Ready.Store(false)
	if p.Connect != nil {
		if err := p.until(ctx, func(context.Context) error { return p.Connect() }); err != nil {
			return err
		}
	}
	p.Ready.Store(true)
	for {
		m, err := p.Source.Next(ctx)
		if err != nil {
			return err
		}
		p.Pending.Store(1)
		err = p.process(ctx, m)
		if err != nil {
			return fmt.Errorf("stopping without commit at %s/%d@%d: %w", m.Topic, m.Partition, m.Offset, err)
		}
		p.Pending.Store(0)
		p.Lag.Store(uint64(max(0, m.EndOffset-m.Offset-1)))
	}
}

func (p *Processor) process(ctx context.Context, m Message) error {
	r, e, reason := parse(p.Schema, m)
	if reason == "" {
		err := p.until(ctx, func(parent context.Context) error {
			work := parent
			cancel := func() {}
			if p.ProcessTimeout > 0 {
				work, cancel = context.WithTimeout(parent, p.ProcessTimeout)
			}
			defer cancel()
			return p.write(work, m, r, e)
		})
		if p.Rejected(err) {
			reason = reasonRejected
		} else if err != nil {
			return err
		}
	}
	if reason != "" {
		record, err := quarantine(m, reason)
		if err != nil {
			return err
		}
		publishCtx := ctx
		cancel := func() {}
		if p.ProcessTimeout > 0 {
			publishCtx, cancel = context.WithTimeout(ctx, p.ProcessTimeout)
		}
		err = p.retry(publishCtx, func(ctx context.Context) error { return p.Sink.Publish(ctx, record) }, retryable)
		cancel()
		if err != nil {
			return err
		}
		p.Quarantined.Add(1)
	}
	if err := p.retry(ctx, m.Commit, retryable); err != nil {
		return err
	}
	p.Ready.Store(true)
	return nil
}

func (p *Processor) write(ctx context.Context, m Message, r history.Reading, e map[string]any) error {
	if p.Tracer != nil {
		ctx = propagation.TraceContext{}.Extract(ctx, propagation.MapCarrier{fieldTrace: str(e, fieldTrace)})
		var span trace.Span
		ctx, span = p.Tracer.Start(ctx, "history.write", trace.WithSpanKind(trace.SpanKindConsumer))
		defer span.End()
	}
	if err := p.retry(ctx, func(ctx context.Context) error { return p.Store.Write(ctx, r) }, p.Transient); err != nil {
		return err
	}
	mark := history.Watermark{TenantID: r.TenantID, DeviceID: r.DeviceID, Topic: transportTopic(m), Partition: m.Partition, Offset: m.Offset, ObservedAt: r.ObservedAt}
	if err := p.retry(ctx, func(ctx context.Context) error { return p.Store.Confirm(ctx, mark) }, p.Transient); err != nil {
		return err
	}
	p.Written.Add(1)
	p.LastWritten.Store(time.Now().UnixNano())
	return nil
}

func retryable(err error) bool {
	return !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded)
}

func (p *Processor) retry(ctx context.Context, fn func(context.Context) error, canRetry func(error) bool) error {
	delay := p.RetryDelay
	for i := 1; ; i++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := fn(ctx)
		if err == nil {
			return nil
		}
		p.Ready.Store(false)
		if i >= p.Attempts || !canRetry(err) {
			return err
		}
		p.Retries.Add(1)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		delay = min(delay*2, 4*time.Second)
	}
}

// Quarantine must preserve the full source record before its offset can move.
// Larger records stop the consumer for operator recovery from the retained
// source; silently truncating and committing would permanently lose bytes.
func quarantine(m Message, reason string) (Record, error) {
	topic := transportTopic(m)
	if len(m.Value) > maxQuarantineRawBytes {
		return Record{}, fmt.Errorf("%w: %d > %d bytes at %s/%d@%d", errQuarantinePayloadTooLarge, len(m.Value), maxQuarantineRawBytes, m.Topic, m.Partition, m.Offset)
	}
	body, err := json.Marshal(struct {
		Reason    string `json:"reason"`
		Consumer  string `json:"consumer"`
		Topic     string `json:"source_topic"`
		Partition int32  `json:"source_partition"`
		Offset    int64  `json:"source_offset"`
		Raw       []byte `json:"raw_base64"`
		Truncated bool   `json:"truncated"`
	}{reason, consumerGroup, topic, m.Partition, m.Offset, m.Value, false})
	if err != nil {
		return Record{}, err
	}
	tenant := "unknown"
	var e map[string]any
	if json.Unmarshal(m.Value, &e) == nil && history.ValidID(str(e, fieldTenant)) {
		tenant = str(e, fieldTenant)
	}
	return Record{Topic: topicQuarantine, Key: []byte(fmt.Sprintf("%s:%d:%d", topic, m.Partition, m.Offset)), Value: body, Headers: map[string]string{fieldTenant: tenant, "consumer": consumerGroup}}, nil
}

func transportTopic(m Message) string {
	if m.TransportTopic != "" {
		return m.TransportTopic
	}
	return m.Topic
}
