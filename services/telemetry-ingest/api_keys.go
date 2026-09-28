package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	common "greenguard.local/go-common"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// APIKeyVerifier delegates digest and revocation checks to the tenant control plane.
// Every request is checked there, so a revoked key has no positive local cache.
// The caller-provided key never appears in URL, logs, or an error string.
type APIKeyVerifier struct {
	URL         string
	OAuthURL    string
	LookupToken string
	Client      *http.Client
}

func NewAPIKeyVerifier(endpoint, lookupToken string) (*APIKeyVerifier, error) {
	return NewAPIKeyVerifierWithMesh(endpoint, lookupToken, false)
}

func NewAPIKeyVerifierWithMesh(endpoint, lookupToken string, meshMTLS bool) (*APIKeyVerifier, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (loopbackHosts[u.Hostname()] || (meshMTLS && common.InternalMeshHost(u.Hostname()))))) || lookupToken == "" {
		return nil, errors.New("invalid API-key verifier configuration")
	}
	return &APIKeyVerifier{URL: strings.TrimRight(endpoint, "/") + "/v1/internal/credentials/api-key/verify", OAuthURL: strings.TrimRight(endpoint, "/") + "/v1/internal/credentials/oauth-token/verify", LookupToken: lookupToken, Client: &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// VerifyOAuth accepts only a token the control plane has validated against its
// configured issuer/JWKS and first-party one-tenant client mapping.
func (v *APIKeyVerifier) VerifyOAuth(ctx context.Context, token string) (Principal, error) {
	body, _ := json.Marshal(map[string]string{"token": token, "requiredScope": "write:telemetry"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, v.OAuthURL, bytes.NewReader(body))
	if err != nil {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+v.LookupToken)
	client := v.Client
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		return Principal{}, &AuthError{Status: http.StatusUnauthorized, Code: codeInvalidToken}
	}
	if res.StatusCode == http.StatusForbidden {
		return Principal{}, &AuthError{Status: http.StatusForbidden, Code: codeInsufficient}
	}
	if res.StatusCode != http.StatusOK {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	var c keyContext
	if err := json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&c); err != nil || !isUUID(c.TenantID) || !isUUID(c.PrincipalID) || c.PrincipalType != "service" {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	allowed := false
	for _, scope := range c.Scopes {
		if scope == "write:telemetry" {
			allowed = true
		}
	}
	if !allowed {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	return Principal{TenantID: c.TenantID, Subject: c.PrincipalID, Roles: []string{RoleOperator}}, nil
}

// JWT payload is inspected only to choose the verifier. No claim from this
// unverified payload is used for authorization.
func looksLikeM2M(header string) bool {
	if !strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return false
	}
	parts := strings.Split(strings.TrimSpace(header[7:]), ".")
	if len(parts) != 3 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(raw) > 4096 {
		return false
	}
	var claims map[string]any
	if json.Unmarshal(raw, &claims) != nil {
		return false
	}
	grant := claims["gty"]
	if grant == nil {
		grant = claims["grant_type"]
	}
	return grant == "client-credentials" || grant == "client_credentials"
}

type keyContext struct {
	TenantID      string   `json:"tenant_id"`
	PrincipalID   string   `json:"principal_id"`
	PrincipalType string   `json:"principal_type"`
	Scopes        []string `json:"scopes"`
	KeyID         string   `json:"key_id"`
	DeviceID      string   `json:"device_id"`
}

func (v *APIKeyVerifier) Verify(ctx context.Context, authorization, pathDevice string) (Principal, error) {
	if len(authorization) < 8 || !strings.EqualFold(authorization[:7], "Bearer ") {
		return Principal{}, &AuthError{Status: http.StatusUnauthorized, Code: codeInvalidToken}
	}
	key := authorization[7:]
	if !strings.HasPrefix(key, "gg_") {
		return Principal{}, &AuthError{Status: http.StatusUnauthorized, Code: codeInvalidToken}
	}
	body, _ := json.Marshal(map[string]string{"key": key})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, v.URL, bytes.NewReader(body))
	if err != nil {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+v.LookupToken)
	client := v.Client
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		return Principal{}, &AuthError{Status: http.StatusUnauthorized, Code: codeInvalidToken}
	}
	if res.StatusCode != http.StatusOK {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	var c keyContext
	if err := json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&c); err != nil || !isUUID(c.TenantID) || !isUUID(c.PrincipalID) || !isUUID(c.KeyID) || c.PrincipalType != "service" {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	allowed := false
	for _, s := range c.Scopes {
		if s == "write:telemetry" {
			allowed = true
		}
	}
	if !allowed {
		return Principal{}, &AuthError{Status: http.StatusForbidden, Code: codeInsufficient}
	}
	if c.DeviceID != "" {
		if !isUUID(c.DeviceID) || c.DeviceID != pathDevice {
			return Principal{}, &AuthError{Status: http.StatusForbidden, Code: codeInsufficient}
		}
		return Principal{TenantID: c.TenantID, Subject: c.DeviceID, Roles: []string{RoleDevice}, KeyID: c.KeyID}, nil
	}
	return Principal{TenantID: c.TenantID, Subject: c.PrincipalID, Roles: []string{RoleOperator}, KeyID: c.KeyID}, nil
}
