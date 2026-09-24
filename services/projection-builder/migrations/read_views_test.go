package migrations

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestDatabaseReadViewsInvokeTenantRLS(t *testing.T) {
	if os.Getenv("PROJECTION_VIEW_TEST") != "1" {
		t.Skip("set PROJECTION_VIEW_TEST=1 for local read-view acceptance")
	}
	cfg, err := pgx.ParseConfig(os.Getenv("POSTGRES_ADMIN_URL"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.Database = "greenguard_read"
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	tenantA, tenantB := "11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	deviceA, deviceB := "66666666-6666-4666-8666-666666666661", "66666666-6666-4666-8666-666666666662"
	for _, row := range [][2]string{{tenantA, deviceA}, {tenantB, deviceB}} {
		_, err = tx.Exec(ctx, `INSERT INTO public.device_views(tenant_id,device_id,site_id,serial_number,status,inventory_version) VALUES($1,$2,'22222222-2222-4222-8222-222222222222','view-test','active',1) ON CONFLICT (tenant_id,device_id) DO NOTHING`, row[0], row[1])
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err = tx.Exec(ctx, "SET LOCAL ROLE projection_app"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		tenant string
		want   int
	}{{tenantA, 1}, {tenantB, 1}, {"", 0}} {
		if _, err = tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tc.tenant); err != nil {
			t.Fatal(err)
		}
		var count int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM read.device_views WHERE device_id IN ($1,$2)`, deviceA, deviceB).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != tc.want {
			t.Fatalf("tenant %q saw %d rows, want %d", tc.tenant, count, tc.want)
		}
	}
}
