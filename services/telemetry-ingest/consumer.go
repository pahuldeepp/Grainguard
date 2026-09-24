package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

const (
	bindingTopic     = "greenguard.inventory.device.v1"
	bindingGroup     = "telemetry-binding-consumer"
	quarantineTopic  = "greenguard.quarantine.v1"
	bindingMaxRaw    = 64 << 10
	reasonEnvelope   = "bad_envelope"
	reasonKey        = "key_mismatch"
	reasonConflict   = "event_conflict"
	reasonSchema     = "schema_invalid"
	reasonType       = "unknown_event_type"
	reasonDBRejected = "db_rejected"
	reasonHeartbeat  = "heartbeat"
)

type BindingMessage struct {
	Topic      string
	Partition  int32
	Offset     int64
	Key, Value []byte
	Commit     func(context.Context) error
}
type BindingRecord struct {
	Topic      string
	Key, Value []byte
}
type BindingSource interface {
	Next(context.Context) (BindingMessage, error)
}
type BindingSink interface {
	PublishQuarantine(context.Context, BindingRecord) error
}

// BindingConsumer processes one outstanding record across all assigned partitions.
// A failed database operation never turns into a skipped offset.
type BindingConsumer struct {
	Validate             func([]byte) error
	Source               BindingSource
	Sink                 BindingSink
	Apply                func(context.Context, []byte) (BindingOutcome, error)
	Heartbeat            func(context.Context, BindingMessage) error
	RetryDelay           time.Duration
	Attempts             int
	Timeout              time.Duration
	Ready                atomic.Bool
	Quarantined          atomic.Uint64
	HeartbeatQuarantined atomic.Uint64
	Retries              atomic.Uint64
}

func (c *BindingConsumer) Run(ctx context.Context) error {
	c.Ready.Store(true)
	defer c.Ready.Store(false)
	for {
		message, err := c.Source.Next(ctx)
		if err != nil {
			return err
		}
		work, cancel := context.WithTimeout(ctx, c.Timeout)
		err = c.process(work, message)
		cancel()
		if err != nil {
			return err
		}
	}
}

func bindingReason(m BindingMessage) string {
	if m.Topic != bindingTopic || !json.Valid(m.Value) {
		return reasonEnvelope
	}
	var envelope struct {
		EventType string `json:"event_type"`
	}
	_ = json.Unmarshal(m.Value, &envelope)
	switch envelope.EventType {
	case eventRegistered, eventBindingChanged, eventStatusChanged:
	default:
		return reasonType
	}
	event, err := ParseInventoryEvent(m.Value)
	if err != nil {
		return reasonSchema
	}
	if string(m.Key) != event.TenantID+":"+event.DeviceID {
		return reasonKey
	}
	return ""
}

func (c *BindingConsumer) process(ctx context.Context, m BindingMessage) error {
	if string(m.Key) == bindingHeartbeatKey {
		return c.checkpoint(ctx, m)
	}
	reason := bindingReason(m)
	if reason == "" && c.Validate(m.Value) != nil {
		reason = reasonSchema
	}
	if reason == "" {
		err := c.retry(ctx, func(ctx context.Context) error { _, err := c.Apply(ctx, m.Value); return err }, transientBindingError)
		reason = bindingDatabaseReason(err)
		if err != nil && reason == "" {
			return err
		}
	}
	if reason != "" {
		record := bindingQuarantine(m, reason)
		if err := c.retry(ctx, func(ctx context.Context) error { return c.Sink.PublishQuarantine(ctx, record) }, retryBindingTransport); err != nil {
			return err
		}
		c.Quarantined.Add(1)
	}
	return c.retry(ctx, m.Commit, retryBindingTransport)
}

func bindingQuarantine(m BindingMessage, reason string) BindingRecord {
	raw := m.Value
	truncated := len(raw) > bindingMaxRaw
	if truncated {
		raw = raw[:bindingMaxRaw]
	}
	body, _ := json.Marshal(struct {
		Reason    string `json:"reason"`
		Topic     string `json:"source_topic"`
		Partition int32  `json:"source_partition"`
		Offset    int64  `json:"source_offset"`
		Raw       []byte `json:"raw_base64"`
		Truncated bool   `json:"truncated"`
	}{reason, m.Topic, m.Partition, m.Offset, raw, truncated})
	return BindingRecord{Topic: quarantineTopic, Key: []byte(fmt.Sprintf("%s:%d:%d", m.Topic, m.Partition, m.Offset)), Value: body}
}

func permanentBindingError(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && len(pg.Code) == 5 && (pg.Code[:2] == "22" || pg.Code[:2] == "23")
}

func transientBindingError(err error) bool {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "40001", "40P01", "55P03", "53300", "57P01", "57P02", "57P03":
			return true
		}
		return len(pg.Code) == 5 && pg.Code[:2] == "08"
	}
	var network net.Error
	return errors.Is(err, io.EOF) || errors.As(err, &network) || pgconn.SafeToRetry(err)
}
func retryBindingTransport(err error) bool {
	return !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded)
}

func (c *BindingConsumer) retry(ctx context.Context, action func(context.Context) error, retryable func(error) bool) error {
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := action(ctx)
		if err == nil {
			c.Ready.Store(true)
			return nil
		}
		c.Ready.Store(false)
		if attempt+1 >= c.Attempts || !retryable(err) {
			return err
		}
		c.Retries.Add(1)
		timer := time.NewTimer(c.RetryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (c *BindingConsumer) metrics() string {
	return "# TYPE binding_consumer_retries_total counter\nbinding_consumer_retries_total " + strconv.FormatUint(c.Retries.Load(), 10) +
		"\n# TYPE binding_consumer_quarantined_total counter\nbinding_consumer_quarantined_total " + strconv.FormatUint(c.Quarantined.Load(), 10) + "\n" +
		"# TYPE binding_consumer_quarantine_total counter\nbinding_consumer_quarantine_total{reason=\"heartbeat\"} " + strconv.FormatUint(c.HeartbeatQuarantined.Load(), 10) + "\n"
}

func (c *BindingConsumer) checkpoint(ctx context.Context, m BindingMessage) error {
	err := c.retry(ctx, func(ctx context.Context) error { return c.Heartbeat(ctx, m) }, transientBindingError)
	reason := checkpointFailureReason(err)
	if reason != "" {
		record := bindingQuarantine(m, reason)
		err = c.retry(ctx, func(ctx context.Context) error { return c.Sink.PublishQuarantine(ctx, record) }, retryBindingTransport)
		if err == nil {
			c.Quarantined.Add(1)
			c.HeartbeatQuarantined.Add(1)
		}
	}
	if err != nil {
		return err
	}
	return c.retry(ctx, m.Commit, retryBindingTransport)
}

func checkpointFailureReason(err error) string {
	if errors.Is(err, ErrInvalidEvent) {
		return reasonHeartbeat
	}
	if permanentBindingError(err) {
		return reasonDBRejected
	}
	return ""
}

func bindingDatabaseReason(err error) string {
	if errors.Is(err, ErrEventConflict) {
		return reasonConflict
	}
	if permanentBindingError(err) {
		return reasonDBRejected
	}
	return ""
}
