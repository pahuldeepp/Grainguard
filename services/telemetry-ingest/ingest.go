package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	bindingActive = "active"

	// Exactly six fractional digits, matching the utcTimestamp format of the event contract.
	timestampLayout = "2006-01-02T15:04:05.000000Z"

	eventTypeTelemetryRecorded = "telemetry.recorded"
	aggregateTelemetryStream   = "device_telemetry_stream"
	statusForbidden            = 403
	statusConflict             = 409
)

// Ingestor stores validated readings durably and idempotently.
type Ingestor struct {
	feed   *BindingFeed
	db     TxStarter
	policy QualityPolicy
	now    func() time.Time
}

func NewIngestor(db TxStarter, policy QualityPolicy, now func() time.Time) *Ingestor {
	if now == nil {
		now = time.Now
	}
	return &Ingestor{db: db, policy: policy.withDefaults(), now: now}
}

type measurementsJSON struct {
	TemperatureC            *float64 `json:"temperature_c,omitempty"`
	RelativeHumidityPercent *float64 `json:"relative_humidity_percent,omitempty"`
}

// normalizedRequest holds only what the caller supplied, so a retry compares equal even
// though its arrival time, trace and the server-derived binding data differ.
type normalizedRequest struct {
	SourceMessageID string           `json:"source_message_id"`
	DeviceID        string           `json:"device_id"`
	ObservedAt      string           `json:"observed_at"`
	Measurements    measurementsJSON `json:"measurements"`
}

type telemetryPayload struct {
	ReadingID       string           `json:"reading_id"`
	DeviceID        string           `json:"device_id"`
	SiteID          string           `json:"site_id"`
	BinID           *string          `json:"bin_id"`
	BindingVersion  string           `json:"binding_version"`
	SourceMessageID string           `json:"source_message_id"`
	ObservedAt      string           `json:"observed_at"`
	ReceivedAt      string           `json:"received_at"`
	Measurements    measurementsJSON `json:"measurements"`
}

type storedBinding struct {
	siteID  string
	binID   *string
	version int64
	status  string
}

// attempt is everything one ingest transaction needs, fixed before it starts.
type attempt struct {
	principal Principal
	deviceID  string
	req       ReadingRequest
	meta      RequestMeta
	now       time.Time
	request   string
	feed      *BindingFeed
	policy    QualityPolicy
}

// record is the set of identifiers and values written by one accepted reading.
type record struct {
	attempt
	binding                              storedBinding
	version                              int64
	readingID, eventID, commandID, audit string
}

func formatTimestamp(t time.Time) string { return t.UTC().Format(timestampLayout) }

func authorize(p Principal, deviceID string) *Rejection {
	if p.HasRole(RoleAdmin) || p.HasRole(RoleOperator) || (p.HasRole(RoleDevice) && p.Subject == deviceID) {
		return nil
	}
	return newRejection(ReasonDeviceForbidden, statusForbidden, "the caller may not submit readings for this device")
}

// Ingest validates and stores one reading. Refusals are returned as *Rejection; any other
// error is internal.
func (g *Ingestor) Ingest(ctx context.Context, p Principal, deviceID string, body []byte, meta RequestMeta) (IngestResult, error) {
	if err := checkRequestMeta(meta); err != nil {
		return IngestResult{}, err
	}
	if !isUUID(deviceID) {
		return IngestResult{}, newRejection(ReasonInvalidField, statusBadRequest, "device id must be a lowercase UUID")
	}
	if rej := authorize(p, deviceID); rej != nil {
		return IngestResult{}, rej
	}
	now := g.now().UTC().Truncate(time.Microsecond)
	req, rej := parseReadingRequest(body)
	if rej != nil {
		return IngestResult{}, rej
	}
	a := attempt{principal: p, deviceID: deviceID, req: req, meta: meta, now: now, policy: g.policy, feed: g.feed}
	normalized, _ := json.Marshal(normalizedRequest{
		SourceMessageID: req.SourceMessageID, DeviceID: deviceID, ObservedAt: formatTimestamp(req.ObservedAt),
		Measurements: measurementsJSON{TemperatureC: req.TemperatureC, RelativeHumidityPercent: req.RelativeHumidityPercent},
	})
	a.request = string(normalized)

	var result IngestResult
	err := WithTenant(ctx, g.db, p.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		result, err = storeReading(ctx, tx, a)
		return err
	})
	if err != nil {
		var refusal *Rejection
		if errors.As(err, &refusal) {
			return IngestResult{}, refusal
		}
		return IngestResult{}, err
	}
	return result, nil
}

// storeReading takes the stream lock before the binding lock, the same order the binding
// consumer uses, so the two can never deadlock.
func storeReading(ctx context.Context, tx pgx.Tx, a attempt) (IngestResult, error) {
	var last int64
	err := tx.QueryRow(ctx,
		`SELECT last_version FROM device_streams WHERE tenant_id = $1 AND device_id = $2 FOR UPDATE`,
		a.principal.TenantID, a.deviceID).Scan(&last)
	if errors.Is(err, pgx.ErrNoRows) {
		return IngestResult{}, newRejection(ReasonDeviceNotReady, statusConflict, "the device has no binding yet")
	}
	if err != nil {
		return IngestResult{}, fmt.Errorf("lock stream: %w", err)
	}
	prior, err := findReceipt(ctx, tx, a)
	if err != nil {
		return IngestResult{}, err
	}
	if prior != nil {
		return *prior, nil
	}
	if rej := checkTimestamp(a.req.ObservedAt, a.now, a.policy); rej != nil {
		return IngestResult{}, rej
	}
	binding, err := lockBinding(ctx, tx, a)
	if err != nil {
		return IngestResult{}, err
	}
	if a.feed != nil {
		if err := a.feed.Check(ctx, tx); err != nil {
			return IngestResult{}, err
		}
	}
	if err := consumeIngestQuota(ctx, tx, a.principal.TenantID, a.now); err != nil {
		return IngestResult{}, err
	}
	rec := record{attempt: a, binding: binding, version: last + 1,
		readingID: newUUIDv4(), eventID: newUUIDv4(), commandID: newUUIDv4(), audit: newUUIDv4()}
	if err := writeRecord(ctx, tx, rec); err != nil {
		return IngestResult{}, err
	}
	return rec.result(), nil
}

func (r record) result() IngestResult {
	return IngestResult{Status: "stored", ReadingID: r.readingID, EventID: r.eventID,
		StreamVersion: fmt.Sprint(r.version), ProjectionStatus: "pending"}
}

// findReceipt returns the stored acknowledgement when the same message was already
// accepted, or an idempotency conflict when it was accepted with different content.
func findReceipt(ctx context.Context, tx pgx.Tx, a attempt) (*IngestResult, error) {
	var stored []byte
	var same bool
	err := tx.QueryRow(ctx,
		`SELECT response_body, normalized_request = $4::jsonb FROM ingest_receipts
		 WHERE tenant_id = $1 AND device_id = $2 AND source_message_id = $3`,
		a.principal.TenantID, a.deviceID, a.req.SourceMessageID, a.request).Scan(&stored, &same)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read receipt: %w", err)
	}
	if !same {
		return nil, newRejection(ReasonIdempotencyConflict, statusConflict, "source_message_id was already used with different content")
	}
	var result IngestResult
	if err := json.Unmarshal(stored, &result); err != nil {
		return nil, fmt.Errorf("decode stored receipt: %w", err)
	}
	return &result, nil
}

func lockBinding(ctx context.Context, tx pgx.Tx, a attempt) (storedBinding, error) {
	var b storedBinding
	err := tx.QueryRow(ctx,
		`SELECT site_id::text, bin_id::text, inventory_version, status FROM device_bindings
		 WHERE tenant_id = $1 AND device_id = $2 FOR SHARE`,
		a.principal.TenantID, a.deviceID).Scan(&b.siteID, &b.binID, &b.version, &b.status)
	if err != nil {
		return storedBinding{}, fmt.Errorf("lock binding: %w", err)
	}
	if b.status != bindingActive {
		return storedBinding{}, newRejection(ReasonDeviceDisabled, statusForbidden, "the device is not active")
	}
	return b, nil
}

// payloadJSON is the outbox payload column; the relay wraps it in the event envelope from
// the row's other columns.
func (r record) payloadJSON() string {
	data, _ := json.Marshal(telemetryPayload{
		ReadingID: r.readingID, DeviceID: r.deviceID, SiteID: r.binding.siteID, BinID: r.binding.binID,
		BindingVersion: fmt.Sprint(r.binding.version), SourceMessageID: r.req.SourceMessageID,
		ObservedAt: formatTimestamp(r.req.ObservedAt), ReceivedAt: formatTimestamp(r.now),
		Measurements: measurementsJSON{TemperatureC: r.req.TemperatureC, RelativeHumidityPercent: r.req.RelativeHumidityPercent},
	})
	return string(data)
}

func (r record) actorType() string {
	if r.principal.HasRole(RoleDevice) {
		return "device"
	}
	return "user"
}

func (r record) responseJSON() string {
	data, _ := json.Marshal(r.result())
	return string(data)
}

func writeRecord(ctx context.Context, tx pgx.Tx, r record) error {
	writes := []struct {
		name string
		run  func(context.Context, pgx.Tx, record) error
	}{
		{"advance stream", advanceStream}, {"insert reading", insertReading}, {"insert outbox event", insertOutbox},
		{"insert audit event", insertAudit}, {"insert receipt", insertReceipt},
	}
	for _, w := range writes {
		if err := w.run(ctx, tx, r); err != nil {
			return fmt.Errorf("%s: %w", w.name, err)
		}
	}
	return nil
}

func advanceStream(ctx context.Context, tx pgx.Tx, r record) error {
	_, err := tx.Exec(ctx,
		`UPDATE device_streams SET last_version = $3 WHERE tenant_id = $1 AND device_id = $2`,
		r.principal.TenantID, r.deviceID, r.version)
	return err
}

func insertReading(ctx context.Context, tx pgx.Tx, r record) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO readings (tenant_id, reading_id, device_id, stream_version, source_message_id, site_id, bin_id,
		   binding_version, observed_at, received_at, temperature_c, relative_humidity_percent)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		r.principal.TenantID, r.readingID, r.deviceID, r.version, r.req.SourceMessageID, r.binding.siteID, r.binding.binID,
		r.binding.version, r.req.ObservedAt, r.now, r.req.TemperatureC, r.req.RelativeHumidityPercent)
	return err
}

func insertOutbox(ctx context.Context, tx pgx.Tx, r record) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO outbox_events (event_id, tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type,
		   schema_version, occurred_at, correlation_id, causation_id, traceparent, payload)
		 VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11::jsonb)`,
		r.eventID, r.principal.TenantID, aggregateTelemetryStream, r.deviceID, r.version, eventTypeTelemetryRecorded,
		r.now, r.meta.CorrelationID, r.commandID, r.meta.Traceparent, r.payloadJSON())
	return err
}

func insertAudit(ctx context.Context, tx pgx.Tx, r record) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO audit_events (audit_id, tenant_id, actor_type, actor_id, action, resource_type, resource_id,
		   command_id, event_id, outcome, occurred_at)
		 VALUES ($1, $2, $3, $4, 'reading.record', 'reading', $5, $6, $7, 'succeeded', $8)`,
		r.audit, r.principal.TenantID, r.actorType(), r.principal.Subject, r.readingID, r.commandID, r.eventID, r.now)
	return err
}

func insertReceipt(ctx context.Context, tx pgx.Tx, r record) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO ingest_receipts (tenant_id, device_id, source_message_id, command_id, reading_id, event_id,
		   normalized_request, response_body, accepted_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
		r.principal.TenantID, r.deviceID, r.req.SourceMessageID, r.commandID, r.readingID, r.eventID,
		r.request, r.responseJSON(), r.now)
	return err
}

var errInvalidRequestMeta = errors.New("ingest: request meta must carry a lowercase UUID correlation id and a valid sampled-flag traceparent")

var metaTraceparentPattern = regexp.MustCompile(`^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$`)

// checkRequestMeta guards a programming error (the middleware always supplies valid values),
// so a bad value fails here instead of inside the database.
func checkRequestMeta(meta RequestMeta) error {
	parts := metaTraceparentPattern.FindStringSubmatch(meta.Traceparent)
	if !isUUID(meta.CorrelationID) || parts == nil || strings.Trim(parts[1], "0") == "" || strings.Trim(parts[2], "0") == "" {
		return errInvalidRequestMeta
	}
	return nil
}
