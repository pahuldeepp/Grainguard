package main

import (
	"github.com/santhosh-tekuri/jsonschema/v6"
	common "greenguard.local/go-common"
)

type SchemaSet interface{ Validate(map[string]any) *failure }
type schemas map[string]*jsonschema.Schema

var schemaFiles = map[string]string{
	typeTelemetry + "@1":       "telemetry-recorded.v1.schema.json",
	typeTelemetry + "@2":       "telemetry-recorded.v2.schema.json",
	typeRegistered + "@1":      "device-registered.v1.schema.json",
	typeBinding + "@1":         "device-binding-changed.v1.schema.json",
	typeStatus + "@1":          "device-status-changed.v1.schema.json",
	typeSiteChanged + "@1":     "site-changed.v1.schema.json",
	typeBinChanged + "@1":      "bin-changed.v1.schema.json",
	typeCableLayout + "@1":     "cable-layout-changed.v1.schema.json",
	typeRiskAssessed + "@1":    "risk-assessed.v1.schema.json",
	typeRiskAssessed + "@2":    "risk-assessed.v2.schema.json",
	typeRiskPolicy + "@1":      "risk-policy-changed.v1.schema.json",
	typeRiskInvalidated + "@1": "risk-assessment-invalidated.v1.schema.json",
}

func loadSchemas(dir string) (schemas, error) {
	compiled, err := common.CompileSchemas(dir, schemaFiles)
	return schemas(compiled), err
}
func (s schemas) Validate(event map[string]any) *failure {
	return common.ValidateEvent(event, s, routingKey, reasonUnknown, reasonSchema, fail, semantic)
}
