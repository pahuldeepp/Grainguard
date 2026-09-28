package main

import (
	"bytes"
	"encoding/json"
	common "greenguard.local/go-common"
	"path/filepath"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

type bindingSchemas map[string]*jsonschema.Schema

func loadBindingSchemas(dir string) (bindingSchemas, error) {
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	result := make(bindingSchemas)
	for kind, file := range map[string]string{eventCableLayout: "cable-layout-changed.v1.schema.json", eventRegistered: "device-registered.v1.schema.json", eventBindingChanged: "device-binding-changed.v1.schema.json", eventStatusChanged: "device-status-changed.v1.schema.json"} {
		schema, err := compiler.Compile(filepath.Join(dir, file))
		if err != nil {
			return nil, err
		}
		result[kind] = schema
	}
	return result, nil
}
func (s bindingSchemas) Validate(body []byte) error {
	var event map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&event); err != nil {
		return ErrInvalidEvent
	}
	kind, _ := event["event_type"].(string)
	schema := s[kind]
	if schema == nil {
		return ErrInvalidEvent
	}
	if err := schema.Validate(event); err != nil {
		return ErrInvalidEvent
	}
	for _, key := range []string{"event_id", "tenant_id", "aggregate_id", "correlation_id", "causation_id"} {
		value, _ := event[key].(string)
		if !isUUID(value) {
			return ErrInvalidEvent
		}
	}
	trace, _ := event["traceparent"].(string)
	if _, ok := sanitizeTraceparent(trace); !ok {
		return ErrInvalidEvent
	}
	if kind == eventCableLayout {
		return common.ValidateCableLayout(event["payload"].(map[string]any))
	}
	return nil
}
