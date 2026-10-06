package main

import (
	"github.com/santhosh-tekuri/jsonschema/v6"
	common "greenguard.local/go-common"
)

type SchemaSet interface{ Validate(map[string]any) *failure }
type schemas map[string]*jsonschema.Schema

const alertLifecycleSchema = "alert-lifecycle.v1.schema.json"
const servicePrincipalSchema = "service-principal-changed.v1.schema.json"

var schemaFiles = map[string]string{
	typeSiteChanged + "@1":               "site-changed.v1.schema.json",
	typeBinChanged + "@1":                "bin-changed.v1.schema.json",
	typeLotChanged + "@1":                "lot-changed.v1.schema.json",
	typeCableLayout + "@1":               "cable-layout-changed.v1.schema.json",
	typeTelemetry + "@2":                 "telemetry-recorded.v2.schema.json",
	typeTelemetry + "@1":                 "telemetry-recorded.v1.schema.json",
	typeRegistered + "@1":                "device-registered.v1.schema.json",
	typeBinding + "@1":                   "device-binding-changed.v1.schema.json",
	typeStatus + "@1":                    "device-status-changed.v1.schema.json",
	typeRiskAssessed + "@1":              "risk-assessed.v1.schema.json",
	typeRiskAssessed + "@2":              "risk-assessed.v2.schema.json",
	typeRiskPolicyChanged + "@1":         "risk-policy-changed.v1.schema.json",
	typeRiskInvalidated + "@1":           "risk-assessment-invalidated.v1.schema.json",
	typeAlertOpened + "@1":               alertLifecycleSchema,
	typeAlertUpdated + "@1":              alertLifecycleSchema,
	typeAlertAcked + "@1":                alertLifecycleSchema,
	typeAlertEscalated + "@1":            alertLifecycleSchema,
	typeProjection + "@1":                "projection-notification.v1.schema.json",
	typeMembershipChanged + "@1":         "membership-changed.v1.schema.json",
	typeIdentityConnectionChanged + "@1": "identity-connection-changed.v1.schema.json",
	typeTenantCreated + "@1":             "tenant-created.v1.schema.json",
	typeServicePrincipalCreated + "@1":   "service-principal-changed.v1.schema.json",
	typeServicePrincipalRotated + "@1":   "service-principal-changed.v1.schema.json",
	typeServicePrincipalRevoked + "@1":   "service-principal-changed.v1.schema.json",
	typeSubscriptionChanged + "@1":       "subscription-changed.v1.schema.json",
	typeEntitlementsChanged + "@1":       "entitlements-changed.v1.schema.json",
	typeUsageAccepted + "@1":             "usage-accepted.v1.schema.json",
	typeBillingReconciliation + "@1":     "billing-reconciliation-required.v1.schema.json",
	typeBillingCommandRequested + "@1":   "billing-command-requested.v1.schema.json",
	typeFlagConfigurationChanged + "@1":  "flag-configuration-changed.v1.schema.json",
	typeAlertResolved + "@1":             alertLifecycleSchema,
}

func loadSchemas(dir string) (schemas, error) {
	compiled, err := common.CompileSchemas(dir, schemaFiles)
	return schemas(compiled), err
}
func (s schemas) Validate(event map[string]any) *failure {
	return common.ValidateEvent(event, s, routingKey, reasonUnknown, reasonSchema, fail, semantic)
}
