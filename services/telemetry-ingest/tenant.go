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
	return common.WithTenantSchema(ctx, db, tenantID, "", fn)
}

func rollback(tx pgx.Tx) error { return common.Rollback(tx) }
