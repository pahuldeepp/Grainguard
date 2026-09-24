package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	transport "greenguard.local/kafka-transport"
	"io"
	"net"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/twmb/franz-go/pkg/kgo"
)

const consumerName = "projection-builder"
const (
	reasonKey       = "key_mismatch"
	reasonHeaders   = "header_mismatch"
	reasonConflict  = "event_id_conflict"
	reasonDB        = "db_rejected"
	reasonHeartbeat = "invalid_feed_checkpoint"
)

var ErrConflict = errors.New("event identity collision")
var ErrDuplicate = errors.New("semantic duplicate")

type Message = transport.Message
type Record = transport.Record
type Source interface {
	Next(context.Context) (Message, error)
}
type Sink interface {
	PublishQuarantine(context.Context, Record) error
}
type Processor struct {
	Tracer                                                trace.Tracer
	Observations                                          observations
	Source                                                Source
	Sink                                                  Sink
	Schemas                                               SchemaSet
	Apply                                                 func(context.Context, Message, map[string]any) error
	Heartbeat                                             func(context.Context, Message) error
	Attempts                                              int
	RetryDelay, ProcessTimeout                            time.Duration
	Ready                                                 atomic.Bool
	Retries, Quarantined, Duplicates, Collisions, Applied atomic.Uint64
}

func (p *Processor) Run(ctx context.Context) error {
	p.Ready.Store(true)
	defer p.Ready.Store(false)
	for {
		m, err := p.Source.Next(ctx)
		if err != nil {
			return err
		}
		work, cancel := context.WithTimeout(ctx, p.ProcessTimeout)
		err = p.process(work, m)
		cancel()
		if err != nil {
			return err
		}
	}
}
func (p *Processor) validate(m Message) (map[string]any, string) {
	v, err := decode(m.Value)
	if err != nil {
		return nil, reasonEnvelope
	}
	e, ok := v.(map[string]any)
	if !ok {
		return nil, reasonEnvelope
	}
	if f := p.Schemas.Validate(e); f != nil {
		return e, f.Reason
	}
	if route(e) != m.Topic || string(m.Key) != fmt.Sprint(e[fieldTenant])+":"+fmt.Sprint(e[fieldAggregate]) {
		return e, reasonKey
	}
	if !validHeaders(m.Headers, e) {
		return e, reasonHeaders
	}
	return e, ""
}
func validHeaders(headers []kgo.RecordHeader, e map[string]any) bool {
	values := map[string]string{}
	for _, h := range headers {
		if _, ok := values[h.Key]; ok {
			return false
		}
		values[h.Key] = string(h.Value)
	}
	for _, key := range []string{fieldEvent, fieldType, fieldSchema, fieldTenant, fieldCorrelation, fieldTrace} {
		if values[key] != fmt.Sprint(e[key]) {
			return false
		}
	}
	return true
}
func (p *Processor) process(ctx context.Context, m Message) error {
	p.Observations.pending.Store(1)
	p.Observations.frontier(m, false)
	err := p.processRecord(ctx, m)
	if err == nil {
		p.Observations.pending.Store(0)
		p.Observations.frontier(m, true)
	}
	return err
}
func (p *Processor) processRecord(ctx context.Context, m Message) error {
	reason, err := p.handle(ctx, m)
	if err != nil {
		return err
	}
	if reason != "" {
		if err := p.retry(ctx, func(ctx context.Context) error { return p.Sink.PublishQuarantine(ctx, quarantine(m, reason)) }, transportError); err != nil {
			return err
		}
		p.Quarantined.Add(1)
		if reason == reasonConflict {
			p.Collisions.Add(1)
		}
	}
	err = p.retry(ctx, m.Commit, transportError)
	if err == nil {
		p.Ready.Store(true)
	}
	return err
}
func (p *Processor) applyEvent(ctx context.Context, m Message, e map[string]any) error {
	if p.Tracer != nil {
		ctx = propagation.TraceContext{}.Extract(ctx, propagation.MapCarrier{fieldTrace: e[fieldTrace].(string)})
		var span trace.Span
		ctx, span = p.Tracer.Start(ctx, "projection.apply", trace.WithSpanKind(trace.SpanKindConsumer))
		defer span.End()
	}
	err := p.retry(ctx, func(ctx context.Context) error { return p.Apply(ctx, m, e) }, transientError)
	if err == nil {
		occurred, _ := time.Parse(time.RFC3339Nano, e[fieldOccurred].(string))
		p.Observations.observe(time.Since(occurred))
	}
	return err
}
func (p *Processor) handle(ctx context.Context, m Message) (string, error) {
	if string(m.Key) == bindingHeartbeatKey {
		return p.applyHeartbeat(ctx, m)
	}
	e, reason := p.validate(m)
	if reason != "" {
		return reason, nil
	}
	err := p.applyEvent(ctx, m, e)
	if errors.Is(err, ErrDuplicate) {
		p.Duplicates.Add(1)
		return "", nil
	}
	if reason = databaseReason(err); reason != "" {
		return reason, nil
	}
	if err == nil {
		p.Applied.Add(1)
	}
	return "", err
}
func (p *Processor) applyHeartbeat(ctx context.Context, m Message) (string, error) {
	err := p.retry(ctx, func(ctx context.Context) error { return p.Heartbeat(ctx, m) }, transientError)
	if errors.Is(err, ErrCheckpoint) {
		return reasonHeartbeat, nil
	}
	if reason := databaseReason(err); reason != "" {
		return reason, nil
	}
	return "", err
}
func databaseReason(err error) string {
	if errors.Is(err, ErrConflict) {
		return reasonConflict
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) && len(pg.Code) == 5 && (pg.Code[:2] == "22" || pg.Code[:2] == "23") {
		return reasonDB
	}
	return ""
}
func transientError(err error) bool {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "40001", "40P01", "55P03", "53300", "57P01", "57P02", "57P03":
			return true
		}
		return len(pg.Code) == 5 && pg.Code[:2] == "08"
	}
	var n net.Error
	return errors.Is(err, io.EOF) || errors.As(err, &n) || pgconn.SafeToRetry(err)
}
func transportError(err error) bool {
	return !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded)
}
func (p *Processor) retry(ctx context.Context, fn func(context.Context) error, canRetry func(error) bool) error {
	delay := p.RetryDelay
	for i := 0; ; i++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := fn(ctx)
		if err == nil || errors.Is(err, ErrDuplicate) {
			return err
		}
		p.Ready.Store(false)
		if i+1 >= p.Attempts || !canRetry(err) {
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
func quarantine(m Message, reason string) Record {
	raw := m.Value
	truncated := len(raw) > 65536
	if truncated {
		raw = raw[:65536]
	}
	body, _ := json.Marshal(struct {
		Reason    string `json:"reason"`
		Topic     string `json:"source_topic"`
		Partition int32  `json:"source_partition"`
		Offset    int64  `json:"source_offset"`
		Raw       []byte `json:"raw_base64"`
		Truncated bool   `json:"truncated"`
	}{reason, m.Topic, m.Partition, m.Offset, raw, truncated})
	tenant := "unknown"
	var e map[string]any
	if json.Unmarshal(m.Value, &e) == nil {
		if id, ok := e[fieldTenant].(string); ok && tenantPattern.MatchString(id) {
			tenant = id
		}
	}
	return Record{Topic: topicQuarantine, Key: []byte(fmt.Sprintf("%s:%d:%d", m.Topic, m.Partition, m.Offset)), Value: body, Headers: map[string]string{fieldTenant: tenant}}
}
