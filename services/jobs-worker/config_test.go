package main

import "testing"

func TestServerlessCriticalRoutingHasNoRuntimeSwitch(t *testing.T) {
	base := map[string]string{"JOBS_DATABASE_URL": "postgres://jobs", "RABBITMQ_URL": "amqp://rabbit", "SERVERLESS_CRITICAL_ENABLED": "false"}
	cfg, err := loadConfig(func(k string) string { return base[k] })
	if err != nil {
		t.Fatal(err)
	}
	_ = cfg
}

func TestRequiredShardRoutingRejectsLegacyURLFallback(t *testing.T) {
	base := map[string]string{"JOBS_DATABASE_URL": "postgres://jobs", "RABBITMQ_URL": "amqp://rabbit"}
	base["SHARD_ROUTING_REQUIRED"] = "true"
	if _, err := loadConfig(func(k string) string { return base[k] }); err == nil {
		t.Fatal("required shard routing accepted missing registry with legacy URL present")
	}
	base["SHARD_ROUTING_REQUIRED"] = "false"
	if _, err := loadConfig(func(k string) string { return base[k] }); err != nil {
		t.Fatalf("explicit legacy local mode rejected: %v", err)
	}
}

func TestControlPlaneMembershipRequiresSecureEndpointAndCredential(t *testing.T) {
	base := map[string]string{
		"JOBS_DATABASE_URL":      "postgres://jobs",
		"RABBITMQ_URL":           "amqp://rabbit",
		"AUTH_MEMBERSHIP_SOURCE": "control-plane",
		"CONTROL_PLANE_URL":      "http://membership.internal",
		"CONTROL_LOOKUP_TOKEN":   "01234567890123456789012345678901",
	}
	if _, err := loadConfig(func(k string) string { return base[k] }); err == nil {
		t.Fatal("insecure control-plane URL accepted without explicit opt-in")
	}
	base["AUTH_ALLOW_INSECURE_MEMBERSHIP_LOOKUP"] = "true"
	if _, err := loadConfig(func(k string) string { return base[k] }); err != nil {
		t.Fatalf("explicit local HTTP opt-in rejected: %v", err)
	}
	base["AUTH_ALLOW_INSECURE_MEMBERSHIP_LOOKUP"] = "false"
	base["CONTROL_PLANE_URL"] = "https://membership.internal"
	if _, err := loadConfig(func(k string) string { return base[k] }); err != nil {
		t.Fatalf("secure control-plane configuration rejected: %v", err)
	}
	base["CONTROL_LOOKUP_TOKEN"] = "short"
	if _, err := loadConfig(func(k string) string { return base[k] }); err == nil {
		t.Fatal("short control-plane credential accepted")
	}
}

func TestAPIOnlyDoesNotRequireDeliveryTransport(t *testing.T) {
	base := map[string]string{"JOBS_DATABASE_URL": "postgres://jobs", "JOBS_API_ONLY": "true"}
	cfg, err := loadConfig(func(k string) string { return base[k] })
	if err != nil || !cfg.APIOnly {
		t.Fatalf("API-only configuration rejected: %v", err)
	}
	base["JOBS_API_ONLY"] = "false"
	if _, err = loadConfig(func(k string) string { return base[k] }); err == nil {
		t.Fatal("delivery runtime accepted missing RabbitMQ transport")
	}
	base["JOBS_API_ONLY"] = "invalid"
	if _, err = loadConfig(func(k string) string { return base[k] }); err == nil {
		t.Fatal("invalid API-only setting accepted")
	}
}
