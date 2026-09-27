package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	apiKeyScopeWriteTelemetry = "write:telemetry"
	jsonContentType           = "application/json"
	verificationBodyLimit     = 4096
	apiKeyBearerPrefix        = "Bearer "
	apiKeyServicePrincipal    = "service"
	endpointTrailingSlash     = "/"
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
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "https" && !(u.Scheme == "http" && loopbackHosts[u.Hostname()])) || lookupToken == "" {
		return nil, errors.New("invalid API-key verifier configuration")
	}
	baseURL := strings.TrimRight(endpoint, endpointTrailingSlash)
	return &APIKeyVerifier{URL: baseURL + "/v1/internal/credentials/api-key/verify", OAuthURL: baseURL + "/v1/internal/credentials/oauth-token/verify", LookupToken: lookupToken, Client: &http.Client{Timeout: 2 * time.Second}}, nil
}

// VerifyOAuth accepts only a token the control plane has validated against its
// configured issuer/JWKS and first-party one-tenant client mapping.
func (v *APIKeyVerifier) VerifyOAuth(ctx context.Context, token string) (Principal, error) {
	c, status, err := v.verifyRequest(ctx, v.OAuthURL, map[string]string{"token": token, "requiredScope": apiKeyScopeWriteTelemetry})
	if err != nil {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	if status == http.StatusUnauthorized {
		return Principal{}, &AuthError{Status: http.StatusUnauthorized, Code: codeInvalidToken}
	}
	if status == http.StatusForbidden {
		return Principal{}, &AuthError{Status: http.StatusForbidden, Code: codeInsufficient}
	}
	if status != http.StatusOK {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	if !validOAuthContext(c) {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	if !hasWriteTelemetryScope(c.Scopes) {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	return Principal{TenantID: c.TenantID, Subject: c.PrincipalID, Roles: []string{RoleOperator}}, nil
}

func validOAuthContext(c keyContext) bool {
	return isUUID(c.TenantID) && isUUID(c.PrincipalID) && c.PrincipalType == apiKeyServicePrincipal
}

func hasWriteTelemetryScope(scopes []string) bool {
	for _, scope := range scopes {
		if scope == apiKeyScopeWriteTelemetry {
			return true
		}
	}
	return false
}

func (v *APIKeyVerifier) verifyRequest(ctx context.Context, endpoint string, payload map[string]string) (keyContext, int, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return keyContext{}, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return keyContext{}, 0, err
	}
	req.Header.Set("Content-Type", jsonContentType)
	req.Header.Set("Authorization", apiKeyBearerPrefix+v.LookupToken)
	client := v.Client
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return keyContext{}, 0, err
	}
	defer res.Body.Close()
	var principal keyContext
	if err := json.NewDecoder(io.LimitReader(res.Body, verificationBodyLimit)).Decode(&principal); err != nil && res.StatusCode == http.StatusOK {
		return keyContext{}, res.StatusCode, err
	}
	return principal, res.StatusCode, nil
}

// JWT payload is inspected only to choose the verifier. No claim from this
// unverified payload is used for authorization.
func looksLikeM2M(header string) bool {
	if !strings.HasPrefix(strings.ToLower(header), strings.ToLower(apiKeyBearerPrefix)) {
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
	key, err := parseAPIKeyAuthorization(authorization)
	if err != nil {
		return Principal{}, err
	}
	c, status, err := v.verifyRequest(ctx, v.URL, map[string]string{"key": key})
	if err != nil {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	if err := apiKeyResponseError(status); err != nil {
		return Principal{}, err
	}
	return principalFromAPIKeyContext(c, pathDevice)
}

func validAPIKeyContext(c keyContext) bool {
	return isUUID(c.TenantID) && isUUID(c.PrincipalID) && isUUID(c.KeyID) && c.PrincipalType == apiKeyServicePrincipal
}

func parseAPIKeyAuthorization(authorization string) (string, error) {
	if len(authorization) < len(apiKeyBearerPrefix)+1 || !strings.EqualFold(authorization[:len(apiKeyBearerPrefix)], apiKeyBearerPrefix) {
		return "", &AuthError{Status: http.StatusUnauthorized, Code: codeInvalidToken}
	}
	key := authorization[len(apiKeyBearerPrefix):]
	if !strings.HasPrefix(key, "gg_") {
		return "", &AuthError{Status: http.StatusUnauthorized, Code: codeInvalidToken}
	}
	return key, nil
}

func apiKeyResponseError(status int) error {
	if status == http.StatusOK {
		return nil
	}
	if status == http.StatusUnauthorized {
		return &AuthError{Status: http.StatusUnauthorized, Code: codeInvalidToken}
	}
	return &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
}

func principalFromAPIKeyContext(c keyContext, pathDevice string) (Principal, error) {
	if !validAPIKeyContext(c) {
		return Principal{}, &AuthError{Status: http.StatusServiceUnavailable, Code: codeUnavailable}
	}
	if !hasWriteTelemetryScope(c.Scopes) {
		return Principal{}, &AuthError{Status: http.StatusForbidden, Code: codeInsufficient}
	}
	if c.DeviceID == "" {
		return Principal{TenantID: c.TenantID, Subject: c.PrincipalID, Roles: []string{RoleOperator}, KeyID: c.KeyID}, nil
	}
	if !isUUID(c.DeviceID) || c.DeviceID != pathDevice {
		return Principal{}, &AuthError{Status: http.StatusForbidden, Code: codeInsufficient}
	}
	return Principal{TenantID: c.TenantID, Subject: c.DeviceID, Roles: []string{RoleDevice}, KeyID: c.KeyID}, nil
}
