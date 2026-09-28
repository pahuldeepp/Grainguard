package main

import (
	"encoding/json"
	"errors"
	"regexp"
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
	Scope, Tenant, Device string
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
		return Target{Scope: scopeDevice, Tenant: n.TenantID, Device: n.Payload.ResourceID, OccurredAt: occurred}, nil
	case scopeTenant:
		if n.Payload.Purpose == "promotion_changed" || n.Payload.SourceEventType == promotedEventType {
			return Target{}, errInvalidNotification
		}
		return Target{Scope: scopeTenant, Tenant: n.TenantID, OccurredAt: occurred}, nil
	default:
		return Target{}, errInvalidNotification
	}
}
