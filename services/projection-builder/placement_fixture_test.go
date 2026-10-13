package main

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/url"
	"testing"
)

// fixturePlacementTracer attaches trusted local placement to legacy live fixtures.
// Production admission and row fences still run under the runtime role. Only
// the separate privileged fixture connection may register fresh ownership.
type fixturePlacementTracer struct {
	t        *testing.T
	adminURL string
}

func configureFixturePlacement(t *testing.T, cfg *pgxpool.Config) {
	t.Helper()
	admin, err := url.Parse(envOrSkip(t, "POSTGRES_ADMIN_URL"))
	if err != nil {
		t.Fatal(err)
	}
	admin.Path = "/" + cfg.ConnConfig.Database
	cfg.ConnConfig.Tracer = fixturePlacementTracer{t, admin.String()}
}
func (f fixturePlacementTracer) TraceQueryStart(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if ctx.Err() != nil {
		return ctx
	}
	if data.SQL != "SELECT set_config('app.tenant_id', $1, true)" || len(data.Args) != 1 {
		return ctx
	}
	tenant, ok := data.Args[0].(string)
	if !ok || !tenantPattern.MatchString(tenant) {
		return ctx
	}
	admin, err := pgx.Connect(ctx, f.adminURL)
	if err != nil {
		if ctx.Err() == nil {
			f.t.Error(err)
		}
		return ctx
	}
	defer admin.Close(ctx)
	var exists bool
	if err = admin.QueryRow(ctx, "SELECT to_regclass('greenguard_internal.tenant_ownership') IS NOT NULL").Scan(&exists); err != nil {
		if ctx.Err() == nil {
			f.t.Error(err)
		}
		return ctx
	}
	// Historical migration fixtures intentionally start before ownership exists.
	if !exists {
		return ctx
	}
	incarnation := "10000000-0000-4000-8000-000000000002"
	if _, err = admin.Exec(ctx, `INSERT INTO greenguard_internal.tenant_ownership
 (tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,'s2',$2,1,'active')
 ON CONFLICT(tenant_id) DO NOTHING`, tenant, incarnation); err != nil {
		if ctx.Err() == nil {
			f.t.Error(err)
		}
		return ctx
	}
	var shard, epoch string
	if err = admin.QueryRow(ctx, "SELECT shard_id,shard_incarnation::text,placement_epoch::text FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1", tenant).Scan(&shard, &incarnation, &epoch); err != nil {
		if ctx.Err() == nil {
			f.t.Error(err)
		}
		return ctx
	}
	for _, setting := range [][2]string{{"app.shard_id", shard}, {"app.shard_incarnation", incarnation}, {"app.placement_epoch", epoch}} {
		if _, err = conn.Exec(ctx, "SELECT set_config($1,$2,true)", setting[0], setting[1]); err != nil {
			if ctx.Err() == nil {
				f.t.Error(err)
			}
			return ctx
		}
	}
	return ctx
}
func (f fixturePlacementTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}
