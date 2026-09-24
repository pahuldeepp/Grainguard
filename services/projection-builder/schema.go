package main

import (
	"github.com/santhosh-tekuri/jsonschema/v6"
	common "greenguard.local/go-common"
)

type SchemaSet interface{ Validate(map[string]any) *failure }
type schemas map[string]*jsonschema.Schema

var schemaFiles = map[string]string{
	typeTelemetry + "@1":  "telemetry-recorded.v1.schema.json",
	typeRegistered + "@1": "device-registered.v1.schema.json",
	typeBinding + "@1":    "device-binding-changed.v1.schema.json",
	typeStatus + "@1":     "device-status-changed.v1.schema.json",
}

func loadSchemas(dir string) (schemas, error) {
	compiled, err := common.CompileSchemas(dir, schemaFiles)
	return schemas(compiled), err
}
func (s schemas) Validate(event map[string]any) *failure {
	return common.ValidateEvent(event, s, routingKey, reasonUnknown, reasonSchema, fail, semantic)
}
