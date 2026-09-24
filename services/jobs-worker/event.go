package main

import (
	"bytes"
	"crypto/sha1"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"time"
)

// AlertEvent is the subset of the alert lifecycle envelope (contracts alert-*.v1 on topic
// greenguard.alerts.lifecycle.v1) the dispatcher needs. The contract is owned by
// workflow-alerts and defined in contracts/events/alert-lifecycle.v1.schema.json.
type AlertEvent struct {
	EventID          string       `json:"event_id"`
	EventType        string       `json:"event_type"`
	SchemaVersion    int          `json:"schema_version"`
	OccurredAt       string       `json:"occurred_at"`
	TenantID         string       `json:"tenant_id"`
	AggregateType    string       `json:"aggregate_type"`
	AggregateID      string       `json:"aggregate_id"`
	AggregateVersion string       `json:"aggregate_version"`
	CorrelationID    string       `json:"correlation_id"`
	CausationID      string       `json:"causation_id"`
	Traceparent      string       `json:"traceparent"`
	Payload          AlertPayload `json:"payload"`
}

type AlertPayload struct {
	EpisodeID      string `json:"episode_id"`
	EpisodeVersion string `json:"episode_version"`
	Severity       string `json:"severity"`
}

var (
	uuidPattern        = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	traceparentPattern = regexp.MustCompile(`^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$`)
	severityPattern    = regexp.MustCompile(`^[a-z][a-z_]{0,31}$`)
	ruleKeyPattern     = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
	knownTransitions   = map[string]bool{eventOpened: true, eventUpdated: true, eventAcknowledged: true, eventEscalated: true, eventResolved: true}
)

const (
	eventOpened       = "alert.opened"
	eventUpdated      = "alert.updated"
	eventAcknowledged = "alert.acknowledged"
	eventEscalated    = "alert.escalated"
	eventResolved     = "alert.resolved"
)

// ErrPoison marks an event that can never be processed; it is quarantined, not retried.
var ErrPoison = errors.New("poison alert event")

func poison(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrPoison, fmt.Sprintf(format, args...))
}

// ParseAlertEvent decodes strictly and validates identity fields before any database work.
func ParseAlertEvent(raw []byte) (AlertEvent, error) {
	var ev AlertEvent
	if err := validateAlertShape(raw); err != nil {
		return ev, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&ev); err != nil {
		return ev, poison("decode: %v", err)
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return ev, poison("trailing JSON")
	}
	if !knownTransitions[ev.EventType] || ev.SchemaVersion != 1 || ev.AggregateType != "alert_episode" {
		return ev, poison("unsupported event %q v%d", ev.EventType, ev.SchemaVersion)
	}
	for name, id := range map[string]string{"event_id": ev.EventID, "tenant_id": ev.TenantID, "aggregate_id": ev.AggregateID, "correlation_id": ev.CorrelationID, "causation_id": ev.CausationID, "payload.episode_id": ev.Payload.EpisodeID} {
		if !uuidPattern.MatchString(id) {
			return ev, poison("%s is not a lowercase UUID", name)
		}
	}
	if ev.Payload.EpisodeID != ev.AggregateID {
		return ev, poison("payload.episode_id differs from aggregate_id")
	}
	if _, err := ev.Version(); err != nil {
		return ev, poison("aggregate_version: %v", err)
	}
	if ev.Payload.EpisodeVersion != ev.AggregateVersion {
		return ev, poison("payload.episode_version differs from aggregate_version")
	}
	if !traceparentPattern.MatchString(ev.Traceparent) || !severityPattern.MatchString(ev.Payload.Severity) {
		return ev, poison("invalid traceparent or severity")
	}
	if ev.Payload.Severity != "warning" && ev.Payload.Severity != "critical" {
		return ev, poison("unsupported severity")
	}
	return ev, nil
}

var alertTopFields = []string{"event_id", "event_type", "schema_version", "occurred_at", "tenant_id", "aggregate_type", "aggregate_id", "aggregate_version", "correlation_id", "causation_id", "traceparent", "payload"}
var alertPayloadFields = []string{"episode_id", "episode_version", "rule_id", "rule_key", "resource_type", "resource_id", "state", "severity", "score", "open_window_start", "opened_at", "transition_at", "acknowledged_by", "escalation_level", "source_event_id"}

func exactFields(raw []byte, fields []string) (map[string]json.RawMessage, error) {
	var values map[string]json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil || values == nil {
		return nil, poison("invalid object")
	}
	if len(values) != len(fields) {
		return nil, poison("missing or unknown field")
	}
	for _, field := range fields {
		if _, ok := values[field]; !ok {
			return nil, poison("missing %s", field)
		}
	}
	return values, nil
}

func rawString(raw json.RawMessage) string { var s string; _ = json.Unmarshal(raw, &s); return s }
func validUTC(raw json.RawMessage) bool {
	s := rawString(raw)
	if s == "" || len(s) < 20 || s[len(s)-1] != 'Z' {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, s)
	return err == nil
}

func validateAlertShape(raw []byte) error {
	top, err := exactFields(raw, alertTopFields)
	if err != nil {
		return err
	}
	p, err := exactFields(top["payload"], alertPayloadFields)
	if err != nil {
		return err
	}
	for _, field := range []string{"occurred_at"} {
		if !validUTC(top[field]) {
			return poison("invalid %s", field)
		}
	}
	for _, field := range []string{"open_window_start", "opened_at", "transition_at"} {
		if !validUTC(p[field]) {
			return poison("invalid payload.%s", field)
		}
	}
	for _, field := range []string{"rule_id", "resource_id"} {
		if !uuidPattern.MatchString(rawString(p[field])) {
			return poison("invalid payload.%s", field)
		}
	}
	if !ruleKeyPattern.MatchString(rawString(p["rule_key"])) || rawString(p["resource_type"]) != "bin" {
		return poison("invalid rule key or resource type")
	}
	var score, level int
	if json.Unmarshal(p["score"], &score) != nil || score < 0 || score > 100 || json.Unmarshal(p["escalation_level"], &level) != nil || level < 0 || level > 10 {
		return poison("invalid score or escalation level")
	}
	return validateAlertSemantics(top, p)
}

func validateAlertSemantics(top, p map[string]json.RawMessage) error {
	state := rawString(p["state"])
	typeName := rawString(top["event_type"])
	allowed := map[string][]string{eventOpened: {"open"}, eventUpdated: {"open", "acknowledged"}, eventAcknowledged: {"acknowledged"}, eventEscalated: {"open"}, eventResolved: {"resolved"}}
	validState := false
	for _, s := range allowed[typeName] {
		if s == state {
			validState = true
		}
	}
	if !validState {
		return poison("invalid state for transition")
	}
	actor := rawString(p["acknowledged_by"])
	if string(p["acknowledged_by"]) != "null" && (actor == "" || len(actor) > 255) {
		return poison("invalid acknowledged_by")
	}
	if typeName == eventAcknowledged && actor == "" {
		return poison("acknowledgement needs actor")
	}
	return validateAlertSource(top, p, typeName)
}

func validateAlertSource(top, p map[string]json.RawMessage, typeName string) error {
	source := rawString(p["source_event_id"])
	riskCaused := typeName == eventOpened || typeName == eventUpdated || typeName == eventResolved
	if string(p["source_event_id"]) != "null" && source == "" {
		return poison("invalid source_event_id")
	}
	if riskCaused != (source != "") || source != "" && (!uuidPattern.MatchString(source) || source != rawString(top["causation_id"])) {
		return poison("invalid source_event_id")
	}
	return nil
}

// Version is the committed alert transition version (aggregate_version).
func (e AlertEvent) Version() (int64, error) {
	n, err := strconv.ParseInt(e.AggregateVersion, 10, 64)
	if err != nil || n < 1 || strconv.FormatInt(n, 10) != e.AggregateVersion {
		return 0, errors.New("must be a canonical positive bigint string")
	}
	return n, nil
}

// Channels is the notification policy for a committed transition. Tenant preferences in
// notification-service may still suppress a channel; that is recorded there as a result.
func Channels(eventType, severity string) []string {
	switch eventType {
	case eventOpened, eventEscalated:
		if severity == "critical" {
			return []string{"email", "sms", "push"}
		}
		return []string{"email"}
	case eventResolved:
		return []string{"email"}
	default:
		return nil
	}
}

// intentNamespace is a fixed random namespace for name-based (v5) notification intent IDs.
var intentNamespace = [16]byte{0x5e, 0x3a, 0x0c, 0x51, 0x8b, 0x4f, 0x4c, 0x2e, 0x9d, 0x77, 0x61, 0x0a, 0xd2, 0x3b, 0x14, 0xe9}

// IntentID derives the stable intent identity from the committed alert transition, so a
// Kafka redelivery, a replay or a second worker produces the same ID (RFC 9562 UUIDv5).
func IntentID(tenantID, episodeID string, version int64, channel string) string {
	h := sha1.New()
	h.Write(intentNamespace[:])
	fmt.Fprintf(h, "%s|%s|%d|%s", tenantID, episodeID, version, channel)
	b := h.Sum(nil)[:16]
	b[6] = b[6]&0x0f | 0x50
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
