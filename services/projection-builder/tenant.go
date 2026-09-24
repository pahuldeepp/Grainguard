package main

import (
	"context"
	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
)

var ErrInvalidTenant = common.ErrInvalidTenant
var tenantPattern = common.TenantPattern

type TxStarter = common.TxStarter

func WithTenant(ctx context.Context, db TxStarter, tenantID string, fn func(context.Context, pgx.Tx) error) error {
	return WithTenantSchema(ctx, db, tenantID, "public", fn)
}

func WithTenantSchema(ctx context.Context, db TxStarter, tenantID, schema string, fn func(context.Context, pgx.Tx) error) error {
	if !tenantPattern.MatchString(tenantID) {
		return ErrInvalidTenant
	}
	if schema != "public" && !versionSchemaPattern.MatchString(schema) {
		return ErrInvalidProjectionSchema
	}
	return common.WithTenantSchema(ctx, db, tenantID, schema, fn)
}

func rollback(tx pgx.Tx) error { return common.Rollback(tx) }
