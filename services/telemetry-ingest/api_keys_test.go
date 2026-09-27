package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAPIKeyVerifierUsesOwnerContextAndDeviceBinding(t *testing.T) {
	tenant := "3f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d"
	principal := "7f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d"
	device := "2f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d"
	keyID := "4f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d"
	key := "gg_dev_dev_" + keyID + "_" + strings.Repeat("A", 43)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer lookup" {
			t.Error("missing service authorization")
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["key"] != key {
			t.Error("credential body mismatch")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tenant_id": tenant, "principal_id": principal, "principal_type": "service", "scopes": []string{"write:telemetry"}, "device_id": device, "key_id": keyID})
	}))
	defer server.Close()
	v, err := NewAPIKeyVerifier(server.URL, "lookup")
	if err != nil {
		t.Fatal(err)
	}
	p, err := v.Verify(context.Background(), "Bearer "+key, device)
	if err != nil {
		t.Fatal(err)
	}
	if p.TenantID != tenant || p.Subject != device || p.KeyID != keyID || !p.HasRole(RoleDevice) {
		t.Fatalf("unexpected principal: %+v", p)
	}
	if _, err = v.Verify(context.Background(), "Bearer "+key, principal); err == nil {
		t.Fatal("key wrote another device")
	}
}
func TestPerKeyLimiterDenialDoesNotSpendOtherBuckets(t *testing.T) {
	now := time.Now()
	cfg := LimitConfig{Device: BucketConfig{Rate: 1, Burst: 3}, Tenant: BucketConfig{Rate: 1, Burst: 3}, Key: BucketConfig{Rate: 1, Burst: 1}, MaxEntries: 10}
	limiter := NewTokenBuckets(cfg, func() time.Time { return now })
	if ok, _ := limiter.AllowKey("tenant", "device", "key-a"); !ok {
		t.Fatal("first key denied")
	}
	if ok, _ := limiter.AllowKey("tenant", "device", "key-a"); ok {
		t.Fatal("key limit bypassed")
	}
	if ok, _ := limiter.AllowKey("tenant", "device", "key-b"); !ok {
		t.Fatal("throttled key spent another key's allowance")
	}
}

func TestOAuthTokenVerifierUsesFirstPartyTenant(t *testing.T) {
	tenant := "3f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d"
	principal := "7f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/internal/credentials/oauth-token/verify" {
			t.Error("wrong endpoint")
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["token"] != "signed-token" || body["requiredScope"] != "write:telemetry" {
			t.Error("wrong token request")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tenant_id": tenant, "principal_id": principal, "principal_type": "service", "scopes": []string{"write:telemetry"}})
	}))
	defer server.Close()
	v, err := NewAPIKeyVerifier(server.URL, "lookup")
	if err != nil {
		t.Fatal(err)
	}
	p, err := v.VerifyOAuth(context.Background(), "signed-token")
	if err != nil || p.TenantID != tenant || p.Subject != principal || !p.HasRole(RoleOperator) {
		t.Fatalf("OAuth context: %+v %v", p, err)
	}
}
