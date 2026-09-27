package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"

	"github.com/jackc/pgx/v5"
)

// Outcomes of applying an inventory event to the local device bindings.
type BindingOutcome string

const (
	BindingApplied   BindingOutcome = "applied"
	BindingDuplicate BindingOutcome = "duplicate"
	BindingStale     BindingOutcome = "stale"
)

var (
	ErrInvalidEvent   = errors.New("invalid inventory event")
	ErrEventConflict  = errors.New("event id was reused with different content")
	ErrBindingMissing = errors.New("device binding is not available yet")
	ErrVersionGap     = errors.New("inventory event is ahead of the local binding version")
)

const bindingConsumer = "device-binding"

var versionPattern = regexp.MustCompile(`^[1-9]\d{0,18}$`)

func isUUID(value string) bool { return tenantPattern.MatchString(value) }

// InventoryEvent is the subset of the canonical device event that the binding needs.
type InventoryEvent struct {
	EventID   string
	EventType string
	TenantID  string
	DeviceID  string
	Version   int64
	SiteID    string
	BinID     *string
	Status    string
	raw       []byte
}

type wireEvent struct {
	EventID          string `json:"event_id"`
	EventType        string `json:"event_type"`
	SchemaVersion    int    `json:"schema_version"`
	TenantID         string `json:"tenant_id"`
	AggregateType    string `json:"aggregate_type"`
	AggregateID      string `json:"aggregate_id"`
	AggregateVersion string `json:"aggregate_version"`
	Payload          struct {
		DeviceID       string  `json:"device_id"`
		SiteID         string  `json:"site_id"`
		BinID          *string `json:"bin_id"`
		Status         string  `json:"status"`
		BindingVersion string  `json:"binding_version"`
	} `json:"payload"`
}

var statuses = map[string]bool{"active": true, "disabled": true, "deleted": true}

const (
	eventRegistered     = "device.registered"
	eventBindingChanged = "device.binding_changed"
	eventStatusChanged  = "device.status_changed"
)

func invalid(reason string) error { return fmt.Errorf("%w: %s", ErrInvalidEvent, reason) }

// checkEnvelope validates the identifiers, versions and aggregate of an event and returns
// its version.
func checkEnvelope(w *wireEvent) (int64, error) {
	if !isUUID(w.EventID) || !isUUID(w.TenantID) || !isUUID(w.AggregateID) {
		return 0, invalid("identifiers must be lowercase non-nil UUIDs")
	}
	if w.SchemaVersion != 1 || w.AggregateType != "device" {
		return 0, invalid("unsupported schema version or aggregate type")
	}
	if !versionPattern.MatchString(w.AggregateVersion) || w.Payload.BindingVersion != w.AggregateVersion {
		return 0, invalid("versions must be equal positive decimal strings")
	}
	version, err := strconv.ParseInt(w.AggregateVersion, 10, 64)
	if err != nil {
		return 0, invalid("version exceeds int64")
	}
	if w.Payload.DeviceID != w.AggregateID {
		return 0, invalid("payload device differs from aggregate")
	}
	return version, nil
}

// checkPayload copies the fields the event type carries into the event.
func checkPayload(w *wireEvent, event *InventoryEvent) error {
	switch w.EventType {
	case eventRegistered, eventBindingChanged:
		if !isUUID(w.Payload.SiteID) || (w.Payload.BinID != nil && !isUUID(*w.Payload.BinID)) {
			return invalid("site and bin must be UUIDs")
		}
		event.SiteID, event.BinID = w.Payload.SiteID, w.Payload.BinID
		if w.EventType == eventBindingChanged {
			return nil
		}
	case eventStatusChanged:
	default:
		return invalid("unknown event type")
	}
	if !statuses[w.Payload.Status] {
		return invalid("unknown status")
	}
	event.Status = w.Payload.Status
	return nil
}

// ParseInventoryEvent checks the fields the binding depends on. Full schema validation
// belongs to the event contract; this rejects anything the binding could misapply.
func ParseInventoryEvent(data []byte) (InventoryEvent, error) {
	var w wireEvent
	if err := json.Unmarshal(data, &w); err != nil {
		return InventoryEvent{}, invalid("not a JSON event")
	}
	version, err := checkEnvelope(&w)
	if err != nil {
		return InventoryEvent{}, err
	}
	event := InventoryEvent{
		EventID: w.EventID, EventType: w.EventType, TenantID: w.TenantID,
		DeviceID: w.AggregateID, Version: version, raw: data,
	}
	if err := checkPayload(&w, &event); err != nil {
		return InventoryEvent{}, err
	}
	return event, nil
}

// ApplyInventoryEvent installs or updates a device's local binding in one transaction:
// the inbox receipt, the binding and the device's ingest stream commit together.
// Lock order is stream row, then binding row, matching the ingest path.
//
// Duplicate delivery is a no-op. A change must be the next version in the device's
// sequence: an older one is stale, a later one is ErrVersionGap, and a change for an
// unknown device is ErrBindingMissing. Those errors roll back everything, including the
// inbox receipt, so redelivery is safe.
func ApplyInventoryEvent(ctx context.Context, db TxStarter, data []byte) (BindingOutcome, error) {
	event, err := ParseInventoryEvent(data)
	if err != nil {
		return "", err
	}
	outcome := BindingApplied
	err = WithTenant(ctx, db, event.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`WITH lock AS (SELECT pg_advisory_xact_lock(hashtextextended($2::text || ':' || $5::text, 0)))
			 INSERT INTO consumer_inbox (consumer_name, tenant_id, event_id, event)
			 SELECT $1, $2::uuid, $3::uuid, $4::jsonb FROM lock ON CONFLICT DO NOTHING`,
			bindingConsumer, event.TenantID, event.EventID, string(event.raw), event.DeviceID)
		if err != nil {
			return fmt.Errorf("record receipt: %w", err)
		}
		if tag.RowsAffected() == 0 {
			outcome, err = duplicateOutcome(ctx, tx, event)
			return err
		}
		outcome, err = applyBinding(ctx, tx, event)
		if err != nil {
			return err
		}
		return completeReadyBindingAwaits(ctx, tx, event.TenantID, event.DeviceID)
	})
	if err != nil {
		return "", err
	}
	return outcome, nil
}

func duplicateOutcome(ctx context.Context, tx pgx.Tx, event InventoryEvent) (BindingOutcome, error) {
	var same bool
	err := tx.QueryRow(ctx,
		`SELECT event = $4::jsonb FROM consumer_inbox
		 WHERE consumer_name = $1 AND tenant_id = $2 AND event_id = $3`,
		bindingConsumer, event.TenantID, event.EventID, string(event.raw)).Scan(&same)
	if err != nil {
		return "", fmt.Errorf("compare receipt: %w", err)
	}
	if !same {
		return "", ErrEventConflict
	}
	return BindingDuplicate, nil
}

func applyBinding(ctx context.Context, tx pgx.Tx, event InventoryEvent) (BindingOutcome, error) {
	var one int
	err := tx.QueryRow(ctx,
		`SELECT 1 FROM device_streams WHERE tenant_id = $1 AND device_id = $2 FOR UPDATE`,
		event.TenantID, event.DeviceID).Scan(&one)
	known := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("lock stream: %w", err)
	}
	if event.EventType == eventRegistered {
		if known {
			return BindingStale, nil
		}
		return BindingApplied, insertBinding(ctx, tx, event)
	}
	if !known {
		return "", ErrBindingMissing
	}
	var current int64
	if err := tx.QueryRow(ctx,
		`SELECT inventory_version FROM device_bindings
		 WHERE tenant_id = $1 AND device_id = $2 FOR UPDATE`,
		event.TenantID, event.DeviceID).Scan(&current); err != nil {
		return "", fmt.Errorf("read binding: %w", err)
	}
	if event.Version <= current {
		return BindingStale, nil
	}
	if event.Version != current+1 {
		return "", ErrVersionGap
	}
	return BindingApplied, updateBinding(ctx, tx, event)
}

func insertBinding(ctx context.Context, tx pgx.Tx, event InventoryEvent) error {
	if _, err := tx.Exec(ctx,
		`INSERT INTO device_bindings (tenant_id, device_id, site_id, bin_id, inventory_version, status)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		event.TenantID, event.DeviceID, event.SiteID, event.BinID, event.Version, event.Status); err != nil {
		return fmt.Errorf("insert binding: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO device_streams (tenant_id, device_id) VALUES ($1, $2)`,
		event.TenantID, event.DeviceID); err != nil {
		return fmt.Errorf("insert stream: %w", err)
	}
	return nil
}

func updateBinding(ctx context.Context, tx pgx.Tx, event InventoryEvent) error {
	query := `UPDATE device_bindings SET site_id = $3, bin_id = $4, inventory_version = $5, applied_at = clock_timestamp()
	          WHERE tenant_id = $1 AND device_id = $2`
	args := []any{event.TenantID, event.DeviceID, event.SiteID, event.BinID, event.Version}
	if event.EventType == eventStatusChanged {
		query = `UPDATE device_bindings SET status = $3, inventory_version = $4, applied_at = clock_timestamp()
		         WHERE tenant_id = $1 AND device_id = $2`
		args = []any{event.TenantID, event.DeviceID, event.Status, event.Version}
	}
	if _, err := tx.Exec(ctx, query, args...); err != nil {
		return fmt.Errorf("update binding: %w", err)
	}
	return nil
}
