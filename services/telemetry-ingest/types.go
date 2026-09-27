package main

import "fmt"

// Principal is the verified caller. TenantID comes only from a verified token claim.
type Principal struct {
	Subject  string
	TenantID string
	Roles    []string
	KeyID    string
}

func (p Principal) HasRole(role string) bool {
	for _, r := range p.Roles {
		if r == role {
			return true
		}
	}
	return false
}

// RequestMeta carries the request's correlation and trace identity into the ingest
// transaction. Traceparent is the active server span in W3C form, with only the
// sampled flag (00 or 01).
type RequestMeta struct {
	CorrelationID string
	Traceparent   string
}

// Stable rejection reasons. Each maps to one HTTP status and is returned to the device.
const (
	ReasonInvalidBody         = "invalid_body"
	ReasonInvalidField        = "invalid_field"
	ReasonNoMeasurements      = "no_measurements"
	ReasonNonFiniteValue      = "non_finite_value"
	ReasonValueOutOfRange     = "value_out_of_range"
	ReasonTimestampInFuture   = "timestamp_in_future"
	ReasonTimestampTooOld     = "timestamp_too_old"
	ReasonDeviceForbidden     = "device_forbidden"
	ReasonDeviceNotReady      = "device_not_ready"
	ReasonDeviceDisabled      = "device_disabled"
	ReasonIdempotencyConflict = "idempotency_conflict"
	ReasonRateLimited         = "rate_limited"
	ReasonEntitlementVolume   = "entitlement_volume_exceeded"
)

// Rejection is a reading that was refused. It is reported to the device and never stored
// as a reading. Detail must be safe to show to the caller.
type Rejection struct {
	Reason string
	Status int
	Detail string
}

func (r *Rejection) Error() string { return fmt.Sprintf("%s: %s", r.Reason, r.Detail) }

// IngestResult is the acknowledgement for a stored reading. A retry returns the same one.
type IngestResult struct {
	Status           string `json:"status"`
	ReadingID        string `json:"reading_id"`
	EventID          string `json:"event_id"`
	StreamVersion    string `json:"stream_version"`
	ProjectionStatus string `json:"projection_status"`
}

// RejectionCounter is implemented by Metrics.
type RejectionCounter interface {
	IncRejection(reason string)
}
