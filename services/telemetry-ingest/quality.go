package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"strconv"
	"time"
)

const (
	maxBodyBytes         = 16 << 10
	defaultMaxFutureSkew = 5 * time.Minute
	defaultMaxAge        = 168 * time.Hour

	fieldSourceMessageID = "source_message_id"
	fieldObservedAt      = "observed_at"
	fieldTemperature     = "temperature_c"
	fieldHumidity        = "relative_humidity_percent"

	statusBadRequest    = 400
	statusUnprocessable = 422
)

// Same rule as the telemetry.recorded v1 contract, so every accepted reading yields a valid event.
var sourceMessageIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

var allowedFields = map[string]bool{
	fieldSourceMessageID: true, fieldObservedAt: true, fieldTemperature: true, fieldHumidity: true,
}

// ReadingRequest is a validated reading. Absent measurements are nil, never zero.
type ReadingRequest struct {
	SourceMessageID         string
	ObservedAt              time.Time
	TemperatureC            *float64
	RelativeHumidityPercent *float64
}

// QualityPolicy bounds how far observed_at may be from the server clock.
type QualityPolicy struct {
	MaxFutureSkew, MaxAge time.Duration
}

func (p QualityPolicy) withDefaults() QualityPolicy {
	if p.MaxFutureSkew == 0 {
		p.MaxFutureSkew = defaultMaxFutureSkew
	}
	if p.MaxAge == 0 {
		p.MaxAge = defaultMaxAge
	}
	return p
}

func newRejection(reason string, status int, detail string) *Rejection {
	return &Rejection{Reason: reason, Status: status, Detail: detail}
}

func decodeObject(body []byte) (map[string]any, *Rejection) {
	if len(body) > maxBodyBytes {
		return nil, newRejection(ReasonInvalidBody, statusBadRequest, "body must be at most 16 KiB")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var fields map[string]any
	if err := dec.Decode(&fields); err != nil || fields == nil {
		return nil, newRejection(ReasonInvalidBody, statusBadRequest, "body must be a JSON object")
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, newRejection(ReasonInvalidBody, statusBadRequest, "body must be a single JSON object")
	}
	for name := range fields {
		if !allowedFields[name] {
			return nil, newRejection(ReasonInvalidBody, statusBadRequest, "body contains an unknown field")
		}
	}
	return fields, nil
}

func parseIdentity(fields map[string]any) (string, time.Time, *Rejection) {
	id, _ := fields[fieldSourceMessageID].(string)
	if !sourceMessageIDPattern.MatchString(id) {
		return "", time.Time{}, newRejection(ReasonInvalidField, statusBadRequest,
			"source_message_id must be 1-128 characters: letters, digits, dot, underscore, colon or hyphen, starting with a letter or digit")
	}
	raw, _ := fields[fieldObservedAt].(string)
	observed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return "", time.Time{}, newRejection(ReasonInvalidField, statusBadRequest, "observed_at must be an RFC 3339 timestamp")
	}
	return id, observed.UTC().Truncate(time.Microsecond), nil
}

// parseMeasurement treats JSON null as absent. Decoding with UseNumber keeps 1e999 from
// silently becoming an error, so overflow is reported as its own reason.
func parseMeasurement(fields map[string]any, name string) (*float64, *Rejection) {
	raw := fields[name]
	if raw == nil {
		return nil, nil
	}
	number, ok := raw.(json.Number)
	if !ok {
		return nil, newRejection(ReasonInvalidField, statusBadRequest, name+" must be a number")
	}
	value, _ := strconv.ParseFloat(number.String(), 64)
	if math.IsInf(value, 0) || math.IsNaN(value) {
		return nil, newRejection(ReasonNonFiniteValue, statusUnprocessable, name+" must be a finite number")
	}
	return &value, nil
}

func checkRange(name string, value *float64, low, high float64) *Rejection {
	if value != nil && (*value < low || *value > high) {
		return newRejection(ReasonValueOutOfRange, statusUnprocessable, name+" is outside the accepted range")
	}
	return nil
}

func parseMeasurements(fields map[string]any) (temperature, humidity *float64, rej *Rejection) {
	if temperature, rej = parseMeasurement(fields, fieldTemperature); rej != nil {
		return nil, nil, rej
	}
	if humidity, rej = parseMeasurement(fields, fieldHumidity); rej != nil {
		return nil, nil, rej
	}
	if temperature == nil && humidity == nil {
		return nil, nil, newRejection(ReasonNoMeasurements, statusUnprocessable, "at least one measurement is required")
	}
	if rej = checkRange(fieldTemperature, temperature, -80, 120); rej != nil {
		return nil, nil, rej
	}
	return temperature, humidity, checkRange(fieldHumidity, humidity, 0, 100)
}

func checkTimestamp(observed, now time.Time, policy QualityPolicy) *Rejection {
	if observed.Sub(now) > policy.MaxFutureSkew {
		return newRejection(ReasonTimestampInFuture, statusUnprocessable, "observed_at is too far in the future")
	}
	if now.Sub(observed) > policy.MaxAge {
		return newRejection(ReasonTimestampTooOld, statusUnprocessable, "observed_at is too old")
	}
	return nil
}

// ParseReadingRequest validates a device payload against the ingest data-quality rules.
func ParseReadingRequest(body []byte, now time.Time, policy QualityPolicy) (ReadingRequest, *Rejection) {
	fields, rej := decodeObject(body)
	if rej != nil {
		return ReadingRequest{}, rej
	}
	id, observed, rej := parseIdentity(fields)
	if rej != nil {
		return ReadingRequest{}, rej
	}
	temperature, humidity, rej := parseMeasurements(fields)
	if rej != nil {
		return ReadingRequest{}, rej
	}
	if rej := checkTimestamp(observed, now.UTC().Truncate(time.Microsecond), policy.withDefaults()); rej != nil {
		return ReadingRequest{}, rej
	}
	return ReadingRequest{SourceMessageID: id, ObservedAt: observed, TemperatureC: temperature, RelativeHumidityPercent: humidity}, nil
}
