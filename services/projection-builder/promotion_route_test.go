package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type routeRow struct{ definition string }

func (r routeRow) Scan(dst ...any) error { *(dst[0].(*string)) = r.definition; return nil }

type routeTx struct {
	pgx.Tx
	definitions []string
	at          int
}

func (t *routeTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func TestPrivilegedTenantCensusInDisposableDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := replayTestDB(t, ctx)
	for _, tenant := range []string{randomUUID(), randomUUID()} {
		if err := WithTenant(ctx, pool, tenant, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO device_views(tenant_id,device_id,site_id,serial_number,status,inventory_version) VALUES($1,$2,$3,'serial','online',1)`, tenant, randomUUID(), randomUUID())
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	unsafe, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := projectionTenants(ctx, unsafe, "public"); err == nil {
		t.Fatal("RLS-filtered role produced a complete census")
	}
	_ = unsafe.Rollback(ctx)
	admin, err := pgx.Connect(ctx, databaseURL(t, envOrSkip(t, "POSTGRES_ADMIN_URL"), pool.Config().ConnConfig.Database))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	tx, err := admin.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	active, err := activeReadSchema(ctx, tx)
	if err != nil || active != "public" {
		t.Fatalf("active route=%q err=%v", active, err)
	}
	tenants, err := projectionTenants(ctx, tx, "public")
	if err != nil || len(tenants) != 2 {
		t.Fatalf("tenant census=%v err=%v", tenants, err)
	}
}

func (t *routeTx) QueryRow(_ context.Context, _ string, _ ...any) pgx.Row {
	if t.at >= len(t.definitions) {
		return routeRow{""}
	}
	r := routeRow{t.definitions[t.at]}
	t.at++
	return r
}

func TestActiveReadSchemaRejectsMixedAndModifiedRoutes(t *testing.T) {
	for _, tc := range []struct {
		name        string
		definitions []string
		want        string
		fail        bool
	}{
		{"public", []string{"SELECT device_views.tenant_id FROM public.device_views;", "SELECT * FROM public.device_latest;", "SELECT * FROM public.reading_history;", "SELECT * FROM public.stream_gaps;", "SELECT * FROM read.device_latest JOIN public.consumer_inbox LEFT JOIN read.reading_history"}, "public", false},
		{"version", []string{"SELECT * FROM read_v2.device_views;", "SELECT * FROM read_v2.device_latest;", "SELECT * FROM read_v2.reading_history;", "SELECT * FROM read_v2.stream_gaps;", "SELECT * FROM read.device_latest JOIN read_v2.consumer_inbox LEFT JOIN read.reading_history"}, "read_v2", false},
		{"mixed", []string{"SELECT * FROM public.device_views;", "SELECT * FROM read_v2.device_latest;"}, "", true},
		{"filtered", []string{"SELECT * FROM public.device_views WHERE true;"}, "", true},
		{"wrong table", []string{"SELECT * FROM public.device_latest;"}, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := activeReadSchema(context.Background(), &routeTx{definitions: tc.definitions})
			if tc.fail && err == nil {
				t.Fatal("unsafe route accepted")
			}
			if !tc.fail && (err != nil || got != tc.want) {
				t.Fatalf("route=%q err=%v", got, err)
			}
		})
	}
}

func TestCompareTenantCensusRejectsExtraLiveTenant(t *testing.T) {
	a, b := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	source := map[string]referenceState{a: {}}
	if err := compareTenantCensus(source, []string{a}, []string{a}); err != nil {
		t.Fatal(err)
	}
	if err := compareTenantCensus(source, []string{a, b}, []string{a}); err == nil || !strings.Contains(err.Error(), "live tenant census") {
		t.Fatalf("extra live tenant accepted: %v", err)
	}
	if err := compareTenantCensus(source, []string{a}, []string{a, b}); err == nil || !strings.Contains(err.Error(), "shadow tenant census") {
		t.Fatalf("extra shadow tenant accepted: %v", err)
	}
	if err := compareTenantCensus(nil, nil, nil); err == nil {
		t.Fatal("empty reference accepted")
	}
}
