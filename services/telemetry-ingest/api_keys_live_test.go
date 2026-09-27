package main

import (
	"context"
	"net/http/httptest"
	"os"
	"testing"
)

// Run by the control-plane cross-process test, with a live Nest control plane.
func TestMachineAuthLiveControlPlane(t *testing.T) {
	endpoint := os.Getenv("TEST_CONTROL_PLANE_URL")
	if endpoint == "" {
		t.Skip("set TEST_CONTROL_PLANE_URL for cross-process machine-auth test")
	}
	v, err := NewAPIKeyVerifier(endpoint, os.Getenv("TEST_CONTROL_LOOKUP_TOKEN"))
	if err != nil {
		t.Fatal(err)
	}
	tenant := os.Getenv("TEST_EXPECTED_TENANT")
	device := os.Getenv("TEST_DEVICE_ID")
	key := os.Getenv("TEST_API_KEY")
	token := os.Getenv("TEST_M2M_TOKEN")
	stage := os.Getenv("TEST_REVOCATION_STAGE")
	if stage == "" {
		keyPrincipal, err := v.Verify(context.Background(), "Bearer "+key, device)
		if err != nil || keyPrincipal.TenantID != tenant || keyPrincipal.Subject != device || !keyPrincipal.HasRole(RoleDevice) {
			t.Fatalf("key context mismatch: %v", err)
		}
		if _, err = v.Verify(context.Background(), "Bearer "+key, os.Getenv("TEST_OTHER_DEVICE_ID")); err == nil {
			t.Fatal("key authorized another device")
		}
		app := App{APIKeys: v, Limiter: NewTokenBuckets(DefaultLimitConfig(), nil), Metrics: NewMetrics()}
		req := httptest.NewRequest("POST", "/v1/devices/"+device+"/readings", nil)
		req.SetPathValue("deviceId", device)
		req.Header.Set("Authorization", "Bearer "+key)
		if p, _, ok := app.admit(httptest.NewRecorder(), req); !ok || p.TenantID != tenant {
			t.Fatal("ingest admission rejected valid key")
		}
	} else {
		if _, err = v.Verify(context.Background(), "Bearer "+key, device); err == nil {
			t.Fatal("revoked key authorized")
		}
	}
	if stage != "both" {
		principal, err := v.VerifyOAuth(context.Background(), token)
		if err != nil || principal.TenantID != tenant || !principal.HasRole(RoleOperator) {
			t.Fatalf("M2M context mismatch: %v", err)
		}
	} else if _, err = v.VerifyOAuth(context.Background(), token); err == nil {
		t.Fatal("revoked OAuth client authorized")
	}
}
