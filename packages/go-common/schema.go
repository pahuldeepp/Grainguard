package common

import (
	"github.com/santhosh-tekuri/jsonschema/v6"
	"path/filepath"
)

// CompileSchemas shares the canonical contract compiler while each owner
// supplies only the event types it is permitted to consume.
func CompileSchemas(dir string, files map[string]string) (map[string]*jsonschema.Schema, error) {
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	result := make(map[string]*jsonschema.Schema, len(files))
	for key, filename := range files {
		schema, err := compiler.Compile(filepath.Join(dir, filename))
		if err != nil {
			return nil, err
		}
		result[key] = schema
	}
	return result, nil
}

func ValidateEvent[T any](event map[string]any, schemas map[string]*jsonschema.Schema, route func(map[string]any) string, unknownReason, invalidReason string, fail func(string, string) T, semantic func(map[string]any) T) T {
	schema, ok := schemas[route(event)]
	if !ok {
		return fail(unknownReason, "unknown event type or schema version")
	}
	if err := schema.Validate(event); err != nil {
		return fail(invalidReason, "canonical event violates JSON Schema")
	}
	return semantic(event)
}
