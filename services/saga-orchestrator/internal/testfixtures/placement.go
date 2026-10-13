package testfixtures

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
	"net/url"
	"os"
	"testing"
)

// fixturePlacementTracer attaches trusted local placement to legacy live fixtures.
// Production admission and row fences still run under the runtime role. Only
// the separate privileged fixture connection may register fresh ownership.
type fixturePlacementTracer struct {
	t        *testing.T
	adminURL string
}

func ConfigurePlacement(t *testing.T, cfg *pgxpool.Config) {
	t.Helper()
	adminURL := os.Getenv("POSTGRES_ADMIN_URL")
	if adminURL == "" {
		t.Skip("POSTGRES_ADMIN_URL required for trusted placement fixtures")
	}
	admin, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	admin.Path = "/" + cfg.ConnConfig.Database
	cfg.ConnConfig.Tracer = fixturePlacementTracer{t, admin.String()}
}
func (f fixturePlacementTracer) TraceQueryStart(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if data.SQL != "SELECT set_config('app.tenant_id', $1, true)" || len(data.Args) != 1 {
		return ctx
	}
	tenant, ok := data.Args[0].(string)
	if !ok || !common.TenantPattern.MatchString(tenant) {
		return ctx
	}
	admin, err := pgx.Connect(ctx, f.adminURL)
	if err != nil {
		f.reportError(ctx, err)
		return ctx
	}
	defer admin.Close(ctx)
	var exists bool
	if err = admin.QueryRow(ctx, "SELECT to_regclass('greenguard_internal.tenant_ownership') IS NOT NULL").Scan(&exists); err != nil {
		f.reportError(ctx, err)
		return ctx
	}
	// Historical migration fixtures intentionally start before ownership exists.
	if !exists {
		return ctx
	}
	if err := setFixturePlacement(ctx, admin, conn, tenant); err != nil {
		f.reportError(ctx, err)
	}

	return ctx
}
func (f fixturePlacementTracer) reportError(ctx context.Context, err error) {
	if ctx.Err() == nil {
		f.t.Error(err)
	}
}

func setFixturePlacement(ctx context.Context, admin, conn *pgx.Conn, tenant string) error {
	incarnation := "11111111-1111-4111-8111-111111111112"
	if _, err := admin.Exec(ctx, `INSERT INTO greenguard_internal.tenant_ownership
 (tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,'s2',$2,1,'active')
 ON CONFLICT(tenant_id) DO NOTHING`, tenant, incarnation); err != nil {
		return err
	}
	var shard, epoch string
	if err := admin.QueryRow(ctx, "SELECT shard_id,shard_incarnation::text,placement_epoch::text FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1", tenant).Scan(&shard, &incarnation, &epoch); err != nil {
		return err
	}
	for _, setting := range [][2]string{{"app.shard_id", shard}, {"app.shard_incarnation", incarnation}, {"app.placement_epoch", epoch}} {
		if _, err := conn.Exec(ctx, "SELECT set_config($1,$2,true)", setting[0], setting[1]); err != nil {
			return err
		}
	}
	return nil
}

func (f fixturePlacementTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {
	// Admission is attached at query start; completion needs no fixture action.
}
