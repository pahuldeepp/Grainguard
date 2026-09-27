package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	common "greenguard.local/go-common"
)

type membership struct {
	Issuer   string   `json:"issuer"`
	Subject  string   `json:"subject"`
	TenantID string   `json:"tenantId"`
	Roles    []string `json:"roles"`
}

func validRole(role string) bool {
	return role == "viewer" || role == "operator" || role == "admin"
}

func loadMemberships(path string) (map[string]membership, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) > 1<<20 {
		return nil, errors.New("membership file exceeds 1 MiB")
	}
	var items []membership
	if err := json.Unmarshal(data, &items); err != nil {
		return nil, fmt.Errorf("parse membership file: %w", err)
	}
	if items == nil {
		return nil, errors.New("membership file must be an array")
	}
	memberships := make(map[string]membership, len(items))
	for _, item := range items {
		if item.Issuer == "" || item.Subject == "" || !common.TenantPattern.MatchString(item.TenantID) || len(item.Roles) == 0 {
			return nil, errors.New("membership needs issuer, subject, valid tenantId and roles")
		}
		for _, role := range item.Roles {
			if !validRole(role) {
				return nil, errors.New("membership has invalid role")
			}
		}
		key := item.Issuer + "|" + item.Subject
		if _, exists := memberships[key]; exists {
			return nil, errors.New("duplicate membership identity")
		}
		memberships[key] = item
	}
	return memberships, nil
}

func membershipFor(path, issuer, subject string) (membership, error) {
	// Read on each request for immediate local-fixture revocation. Production
	// membership and audit move to the Stage 09 authority service.
	memberships, err := loadMemberships(path)
	if err != nil {
		return membership{}, err
	}
	item, ok := memberships[issuer+"|"+subject]
	if !ok {
		return membership{}, errors.New("identity has no active GreenGuard membership")
	}
	return item, nil
}
