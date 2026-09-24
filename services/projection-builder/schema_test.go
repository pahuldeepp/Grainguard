package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSchemaSemantics(t *testing.T) {
	s, err := loadSchemas("../../contracts/events")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := loadSchemas("/does-not-exist"); err == nil {
		t.Fatal("missing schemas")
	}
	if f := s.Validate(validEvent(t)); f != nil {
		t.Fatal(f)
	}
	for _, key := range []string{fieldTenant, fieldEvent, fieldAggregate, fieldCorrelation, fieldCausation} {
		e := validEvent(t)
		e[key] = "00000000-0000-0000-0000-000000000000"
		if s.Validate(e) == nil {
			t.Fatal(key)
		}
	}
	for _, trace := range []string{"00-" + strings.Repeat("0", 32) + "-0123456789abcdef-01", "00-0123456789abcdef0123456789abcdef-" + strings.Repeat("0", 16) + "-01"} {
		e := validEvent(t)
		e[fieldTrace] = trace
		if s.Validate(e) == nil {
			t.Fatal(trace)
		}
	}
	for _, v := range []any{"0", "01", "9223372036854775808", true, json.Number("-1")} {
		if _, err := bigint(v); err == nil {
			t.Fatal(v)
		}
	}
	if v, err := bigint(json.Number("1")); v != "1" || err != nil {
		t.Fatal(v, err)
	}
	for _, b := range []string{`{} {}`, `{`, `[] trailing`} {
		if _, err := decode([]byte(b)); err == nil {
			t.Fatal(b)
		}
	}
	if fail(reasonSchema, "detail").Error() != reasonSchema+": detail" {
		t.Fatal("error text")
	}
}

func TestReservedAndPayloadIdentities(t *testing.T) {
	s, err := loadSchemas("../../contracts/events")
	if err != nil {
		t.Fatal(err)
	}
	e := validEvent(t)
	e[fieldTenant] = infrastructureTenant
	if s.Validate(e) == nil {
		t.Fatal("reserved tenant accepted")
	}
	for _, key := range []string{fieldDevice, "reading_id", "site_id", "bin_id"} {
		e := validEvent(t)
		e[fieldPayload].(map[string]any)[key] = "00000000-0000-0000-0000-000000000000"
		if s.Validate(e) == nil {
			t.Fatal(key)
		}
	}
	if route(map[string]any{fieldType: "facility"}) != "" {
		t.Fatal("unknown routed")
	}
}
