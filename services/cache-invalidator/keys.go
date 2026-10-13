package main

import (
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"time"
)

// Key formats mirror services/read-api/src/cache.ts (ADR-0015, ADR-0016). A tenant's
// generation and device versions share the {t:<tenant>} hash tag, and therefore its slot.
const (
	keyPrefix            = "gg:read:v1"
	epochKey             = keyPrefix + ":epoch"
	notificationType     = "projection.notification"
	notificationTopic    = "greenguard.projection.notification.v1"
	promotedEventType    = "projection.promoted"
	scopeDevice          = "device"
	scopeTenant          = "tenant"
	scopeEpoch           = "epoch"
	infrastructureTenant = "00000000-0000-4000-8000-000000000001"
)

// Same rule as the Read API: anything that could break the hash tag is rejected.
var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

var errInvalidNotification = errors.New("invalid projection notification")

func tenantTag(tenant string) string { return "{t:" + tenant + "}" }

func generationKey(tenant string) string { return keyPrefix + ":" + tenantTag(tenant) + ":gen" }

func deviceVersionKey(tenant, device string) string {
	return keyPrefix + ":" + tenantTag(tenant) + ":d:" + device + ":ver"
}

// Target is one version bump derived from a committed read-model notification.
type Target struct {
	Scope, Tenant, Device                 string
	Incarnation, PlacementEpoch, Sequence string
	// OccurredAt is the projection commit time carried by the notification.
	OccurredAt time.Time
}

// Key returns the Redis version key this target bumps.
func (t Target) Key() string {
	if t.Scope == scopeEpoch {
		return epochKey
	}
	if t.Scope == scopeDevice {
		return deviceVersionKey(t.Tenant, t.Device)
	}
	return generationKey(t.Tenant)
}

type notification struct {
	EventType  string `json:"event_type"`
	TenantID   string `json:"tenant_id"`
	OccurredAt string `json:"occurred_at"`
	Payload    struct {
		Scope           string `json:"scope"`
		ResourceID      string `json:"resource_id"`
		Purpose         string `json:"purpose"`
		SourceEventType string `json:"source_event_type"`
		Incarnation     string `json:"shard_incarnation"`
		PlacementEpoch  string `json:"placement_epoch"`
		Sequence        string `json:"projection_sequence"`
	} `json:"payload"`
}

// parseTarget reads only what invalidation needs. The canonical topic is schema-validated
// by the transformer; anything unexpected here is rejected rather than guessed.
func parseTarget(value []byte) (Target, error) {
	var n notification
	if err := json.Unmarshal(value, &n); err != nil || n.EventType != notificationType || !safeID.MatchString(n.TenantID) {
		return Target{}, errInvalidNotification
	}
	occurred, err := time.Parse(time.RFC3339Nano, n.OccurredAt)
	if err != nil {
		return Target{}, errInvalidNotification
	}
	withWatermark := func(t Target) (Target, error) {
		p := n.Payload
		if p.Incarnation == "" && p.PlacementEpoch == "" && p.Sequence == "" {
			return t, nil
		}
		if !watermarkUUID.MatchString(n.TenantID) || !watermarkUUID.MatchString(p.Incarnation) || !watermarkDecimal.MatchString(p.PlacementEpoch) || !watermarkDecimal.MatchString(p.Sequence) {
			return Target{}, errInvalidNotification
		}
		epoch, e := strconv.ParseInt(p.PlacementEpoch, 10, 64)
		if e != nil || epoch < 1 {
			return Target{}, errInvalidNotification
		}
		if _, e = strconv.ParseInt(p.Sequence, 10, 64); e != nil {
			return Target{}, errInvalidNotification
		}
		t.Incarnation, t.PlacementEpoch, t.Sequence = p.Incarnation, p.PlacementEpoch, p.Sequence
		return t, nil
	}
	switch n.Payload.Scope {
	case scopeEpoch:
		if n.TenantID != infrastructureTenant || n.Payload.Purpose != "promotion_changed" || n.Payload.SourceEventType != promotedEventType {
			return Target{}, errInvalidNotification
		}
		return Target{Scope: scopeEpoch, Tenant: n.TenantID, OccurredAt: occurred}, nil
	case scopeDevice:
		if n.Payload.Purpose == "promotion_changed" || n.Payload.SourceEventType == promotedEventType {
			return Target{}, errInvalidNotification
		}
		if !safeID.MatchString(n.Payload.ResourceID) {
			return Target{}, errInvalidNotification
		}
		return withWatermark(Target{Scope: scopeDevice, Tenant: n.TenantID, Device: n.Payload.ResourceID, OccurredAt: occurred})
	case scopeTenant:
		if n.Payload.Purpose == "promotion_changed" || n.Payload.SourceEventType == promotedEventType {
			return Target{}, errInvalidNotification
		}
		return withWatermark(Target{Scope: scopeTenant, Tenant: n.TenantID, OccurredAt: occurred})
	default:
		return Target{}, errInvalidNotification
	}
}

var watermarkUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var watermarkDecimal = regexp.MustCompile(`^(0|[1-9][0-9]{0,18})$`)

func watermarkGuardKey(tenant string) string { return "gg:read:v2:" + tenantTag(tenant) + ":guard" }
