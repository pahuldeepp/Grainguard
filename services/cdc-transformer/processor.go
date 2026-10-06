package main

import (
	"context"
	"encoding/json"
	"fmt"
	transport "greenguard.local/kafka-transport"
	"log/slog"
	"regexp"
	"strconv"
	"time"

	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

const maxRawBytes = 64 * 1024
const unknownTenant = "unknown"

type Message struct {
	Topic          string
	TransportTopic string
	Partition      int32
	Offset         int64
	Value          []byte
	Commit         func(context.Context) error
}
type Record = transport.Record
type Source interface {
	Next(context.Context) (Message, error)
}
type Sink interface {
	Publish(context.Context, Record) error
	PublishQuarantine(context.Context, Record) error
}

type quarantine struct {
	Reason    string `json:"reason"`
	Topic     string `json:"source_topic"`
	Partition int32  `json:"source_partition"`
	Offset    int64  `json:"source_offset"`
	Raw       []byte `json:"raw_base64"`
	Truncated bool   `json:"truncated"`
	Detail    string `json:"detail"`
}

func quarantineRecord(m Message, err *failure) Record {
	if m.TransportTopic != "" {
		m.Topic = m.TransportTopic
	}
	raw := m.Value
	truncated := len(raw) > maxRawBytes
	if truncated {
		raw = raw[:maxRawBytes]
	}
	// Only byte slices, strings and integers: encoding cannot fail.
	body, _ := json.Marshal(quarantine{err.Reason, m.Topic, m.Partition, m.Offset, raw, truncated, err.Detail})
	partition, offset := strconv.Itoa(int(m.Partition)), strconv.FormatInt(m.Offset, 10)
	return Record{Topic: topicQuarantine, Key: []byte(m.Topic + ":" + partition + ":" + offset), Value: body,
		Headers: map[string]string{fieldTenant: quarantineTenant(m.Value), "reason": err.Reason, "source_topic": m.Topic, "source_partition": partition, "source_offset": offset, "truncated": strconv.FormatBool(truncated), "detail": err.Detail}}
}

func canonicalRecord(event map[string]any, topic string) Record {
	// The map consists exclusively of JSON-decoded values, and schema validation
	// has succeeded. Sorted map keys in encoding/json make redelivery deterministic.
	body, _ := json.Marshal(event)
	headers := make(map[string]string)
	for _, key := range []string{fieldEvent, fieldType, fieldSchema, fieldTenant, fieldCorrelation, fieldTrace} {
		headers[key] = fmt.Sprint(event[key])
	}
	tenantKey := "global"
	if tenant, ok := event[fieldTenant].(string); ok {
		tenantKey = tenant
	}
	return Record{Topic: topic, Key: []byte(tenantKey + ":" + event[fieldAggregate].(string)), Value: body, Headers: headers}
}

func transform(m Message, s SchemaSet) (Record, string, *failure) {
	if m.Topic != rawInventory && m.Topic != rawControl && m.Topic != rawBilling && m.Topic != rawTelemetry && m.Topic != rawRisk && m.Topic != rawAlerts && m.Topic != rawProjection {
		return Record{}, "", fail(reasonEnvelope, "unexpected source topic")
	}
	row, ignored, err := unwrap(m.Value)
	if err != nil || ignored != "" {
		return Record{}, ignored, err
	}
	event, err := mapRow(row)
	if err != nil {
		return Record{}, "", err
	}
	topic, invalid := route(event)
	if invalid != nil {
		return Record{}, "", invalid
	}
	if err = s.Validate(event); err != nil {
		return Record{}, "", err
	}
	if sourceForType(event[fieldType]) != m.Topic {
		return Record{}, "", fail(reasonEnvelope, "event type does not belong to source topic")
	}
	return canonicalRecord(event, topic), "", nil
}

func sourceForType(eventType any) string {
	switch eventType {
	case typeTelemetry:
		return rawTelemetry
	case typeMembershipChanged, typeTenantCreated, typeIdentityConnectionChanged, typeServicePrincipalCreated, typeServicePrincipalRotated, typeServicePrincipalRevoked, typeFlagConfigurationChanged:
		return rawControl
	case typeSubscriptionChanged, typeEntitlementsChanged, typeUsageAccepted, typeBillingReconciliation, typeBillingCommandRequested:
		return rawBilling
	case typeRiskAssessed, typeRiskPolicyChanged, typeRiskInvalidated:
		return rawRisk
	case typeAlertOpened, typeAlertUpdated, typeAlertAcked, typeAlertEscalated, typeAlertResolved:
		return rawAlerts
	case typeProjection:
		return rawProjection
	default:
		return rawInventory
	}
}

type Processor struct {
	Source         Source
	Sink           Sink
	Schemas        SchemaSet
	Metrics        *Metrics
	Tracer         trace.Tracer
	RetryDelay     time.Duration
	ProcessTimeout time.Duration
}

func (p *Processor) Run(ctx context.Context) error {
	for {
		message, err := p.Source.Next(ctx)
		if err != nil {
			return err
		}
		p.Metrics.consumed.Add(1)
		p.Metrics.lag.Store(1)
		work, cancel := context.WithTimeout(ctx, p.ProcessTimeout)
		err = p.process(work, message)
		cancel()
		if err != nil {
			return err
		}
		p.Metrics.lag.Store(0)
	}
}

func (p *Processor) process(ctx context.Context, m Message) error {
	if records, ok := heartbeatRecords(m); ok {
		return p.publishHeartbeat(ctx, m, records)
	}
	record, ignored, invalid := transform(m, p.Schemas)
	if ignored != "" {
		p.Metrics.ignored[ignored].Add(1)
		slog.Info("ignored append-only outbox operation", "operation", ignored, "topic", m.Topic, "partition", m.Partition, "offset", m.Offset)
	} else if err := p.deliver(ctx, m, record, invalid); err != nil {
		return err
	}
	// Retry only the commit once delivery succeeds; do not republish on a commit
	// error. A restart may redeliver, which is the documented at-least-once window.
	return p.retry(ctx, m.Commit)
}

func (p *Processor) deliver(ctx context.Context, m Message, record Record, invalid *failure) error {
	publish := p.Sink.Publish
	if invalid != nil {
		record = quarantineRecord(m, invalid)
		publish = p.Sink.PublishQuarantine
	}
	if err := p.retry(ctx, func(ctx context.Context) error { return p.publishAttempt(ctx, publish, record) }); err != nil {
		return err
	}
	if invalid != nil {
		p.Metrics.quarantined[invalid.Reason].Add(1)
	} else {
		p.Metrics.published.Add(1)
	}
	return nil
}

func (p *Processor) publishAttempt(ctx context.Context, publish func(context.Context, Record) error, record Record) error {
	origin := propagation.TraceContext{}.Extract(ctx, propagation.MapCarrier(record.Headers))
	ctx, span := p.Tracer.Start(origin, "cdc publish", trace.WithSpanKind(trace.SpanKindProducer))
	defer span.End()
	err := publish(ctx, record)
	if err != nil {
		span.RecordError(err)
	}
	return err
}

func (p *Processor) retry(ctx context.Context, action func(context.Context) error) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := action(ctx); err == nil {
			p.Metrics.ready.Store(true)
			return nil
		}
		p.Metrics.ready.Store(false)
		timer := time.NewTimer(p.RetryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// Match the lowercase UUID pattern in the event schemas. Never use source metadata.
var quarantineTenantPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func quarantineTenant(raw []byte) string {
	value, err := decode(raw)
	if err != nil {
		return unknownTenant
	}
	envelope, _ := value.(map[string]any)
	if wrapped, ok := envelope[fieldPayload]; ok {
		envelope, _ = wrapped.(map[string]any)
	}
	row, _ := envelope["after"].(map[string]any)
	tenant, _ := row[fieldTenant].(string)
	if quarantineTenantPattern.MatchString(tenant) {
		return tenant
	}
	return unknownTenant
}
