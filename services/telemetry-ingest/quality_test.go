package main

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

var ingNow = time.Date(2026, 9, 21, 15, 0, 0, 123456000, time.UTC)

func ingParse(body string) (ReadingRequest, *Rejection) {
	return ParseReadingRequest([]byte(body), ingNow, QualityPolicy{})
}

func ingReading(extra string) string {
	return `{"source_message_id":"m-1","observed_at":"2026-09-21T14:59:59Z"` + extra + `}`
}

func TestParseRejectsEveryQualityViolationWithItsReason(t *testing.T) {
	long := strings.Repeat("a", 201)
	cases := []struct {
		name, body, reason string
		status             int
	}{
		{"not JSON", `nope`, ReasonInvalidBody, 400},
		{"array", `[1]`, ReasonInvalidBody, 400},
		{"null", `null`, ReasonInvalidBody, 400},
		{"trailing data", ingReading(`,"temperature_c":1`) + ` {}`, ReasonInvalidBody, 400},
		{"unknown field", ingReading(`,"temperature_c":1,"extra":1`), ReasonInvalidBody, 400},
		{"device id in body", ingReading(`,"temperature_c":1,"device_id":"x"`), ReasonInvalidBody, 400},
		{"oversized", `{"source_message_id":"` + strings.Repeat("a", 16<<10) + `"}`, ReasonInvalidBody, 400},
		{"missing message id", `{"observed_at":"2026-09-21T14:59:59Z","temperature_c":1}`, ReasonInvalidField, 400},
		{"message id with space", `{"source_message_id":"a b","observed_at":"2026-09-21T14:59:59Z","temperature_c":1}`, ReasonInvalidField, 400},
		{"message id too long", `{"source_message_id":"` + long + `","observed_at":"2026-09-21T14:59:59Z","temperature_c":1}`, ReasonInvalidField, 400},
		{"message id not a string", `{"source_message_id":5,"observed_at":"2026-09-21T14:59:59Z","temperature_c":1}`, ReasonInvalidField, 400},
		{"missing observed_at", `{"source_message_id":"m","temperature_c":1}`, ReasonInvalidField, 400},
		{"observed_at not RFC 3339", `{"source_message_id":"m","observed_at":"yesterday","temperature_c":1}`, ReasonInvalidField, 400},
		{"observed_at number", `{"source_message_id":"m","observed_at":1,"temperature_c":1}`, ReasonInvalidField, 400},
		{"no measurements", ingReading(``), ReasonNoMeasurements, 422},
		{"null measurements only", ingReading(`,"temperature_c":null,"relative_humidity_percent":null`), ReasonNoMeasurements, 422},
		{"temperature string", ingReading(`,"temperature_c":"5"`), ReasonInvalidField, 400},
		{"humidity bool", ingReading(`,"temperature_c":1,"relative_humidity_percent":true`), ReasonInvalidField, 400},
		{"temperature overflow", ingReading(`,"temperature_c":1e999`), ReasonNonFiniteValue, 422},
		{"humidity negative overflow", ingReading(`,"temperature_c":1,"relative_humidity_percent":-1e999`), ReasonNonFiniteValue, 422},
		{"temperature low", ingReading(`,"temperature_c":-80.0001`), ReasonValueOutOfRange, 422},
		{"temperature high", ingReading(`,"temperature_c":120.0001`), ReasonValueOutOfRange, 422},
		{"humidity low", ingReading(`,"relative_humidity_percent":-0.0001`), ReasonValueOutOfRange, 422},
		{"humidity high", ingReading(`,"temperature_c":1,"relative_humidity_percent":100.0001`), ReasonValueOutOfRange, 422},
		{"future", `{"source_message_id":"m","observed_at":"2026-09-21T15:05:00.123457Z","temperature_c":1}`, ReasonTimestampInFuture, 422},
		{"too old", `{"source_message_id":"m","observed_at":"2026-09-14T15:00:00.123455Z","temperature_c":1}`, ReasonTimestampTooOld, 422},
	}
	for _, c := range cases {
		_, rej := ingParse(c.body)
		if rej == nil || rej.Reason != c.reason || rej.Status != c.status || rej.Detail == "" {
			t.Errorf("%s: got %+v, want %s/%d", c.name, rej, c.reason, c.status)
		}
	}
}

func TestParseAcceptsBoundaryValuesAndNormalisesTime(t *testing.T) {
	accepted := []string{
		ingReading(`,"temperature_c":-80`), ingReading(`,"temperature_c":120`),
		ingReading(`,"temperature_c":0`), ingReading(`,"relative_humidity_percent":0`),
		ingReading(`,"relative_humidity_percent":100`), ingReading(`,"relative_humidity_percent":55.5`),
		ingReading(`,"temperature_c":2,"relative_humidity_percent":null`),
		`{"source_message_id":"m","observed_at":"2026-09-21T15:05:00.123456Z","temperature_c":1}`,
		`{"source_message_id":"m","observed_at":"2026-09-14T15:00:00.123456Z","temperature_c":1}`,
	}
	for _, body := range accepted {
		if _, rej := ingParse(body); rej != nil {
			t.Errorf("%s: %+v", body, rej)
		}
	}
	req, rej := ingParse(`{"source_message_id":"m","observed_at":"2026-09-21T17:00:00.1234567+02:00","relative_humidity_percent":40}`)
	if rej != nil || req.TemperatureC != nil || *req.RelativeHumidityPercent != 40 {
		t.Fatalf("%+v %+v", req, rej)
	}
	if want := time.Date(2026, 9, 21, 15, 0, 0, 123456000, time.UTC); !req.ObservedAt.Equal(want) || req.ObservedAt.Location() != time.UTC {
		t.Fatalf("observed_at %v", req.ObservedAt)
	}
}

func TestParseHonoursACustomPolicy(t *testing.T) {
	policy := QualityPolicy{MaxFutureSkew: time.Second, MaxAge: time.Minute}
	body := fmt.Sprintf(`{"source_message_id":"m","observed_at":%q,"temperature_c":1}`, ingNow.Add(2*time.Second).Format(time.RFC3339Nano))
	if _, rej := ParseReadingRequest([]byte(body), ingNow, policy); rej == nil || rej.Reason != ReasonTimestampInFuture {
		t.Fatalf("%+v", rej)
	}
	body = fmt.Sprintf(`{"source_message_id":"m","observed_at":%q,"temperature_c":1}`, ingNow.Add(-2*time.Minute).Format(time.RFC3339Nano))
	if _, rej := ParseReadingRequest([]byte(body), ingNow, policy); rej == nil || rej.Reason != ReasonTimestampTooOld {
		t.Fatalf("%+v", rej)
	}
}
