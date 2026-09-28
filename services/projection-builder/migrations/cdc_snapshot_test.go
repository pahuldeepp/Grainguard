package migrations

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

const cdcGuardFile = "000012_cdc_snapshot_guard.up.sql"

func cdcGuardSQL(t *testing.T) string {
	t.Helper()
	body, err := files.ReadFile(cdcGuardFile)
	if err != nil {
		t.Fatalf("R1 guard migration missing: %v", err)
	}
	return string(body)
}

func TestCDCGuardNamesTheRoleAndRaises(t *testing.T) {
	sql := cdcGuardSQL(t)
	for _, want := range []string{"RAISE EXCEPTION", "cdc_outbox_snapshot", "GRANT SELECT ON TABLE outbox_events TO cdc_reader"} {
		if !strings.Contains(sql, want) {
			t.Fatalf("guard migration lacks %q", want)
		}
	}
}

// runGuard executes the guard body (optionally with the role renamed) in a transaction
// that is always rolled back, so the shared database and the cluster role are untouched.
func runGuard(t *testing.T, conn *pgx.Conn, role string) error {
	t.Helper()
	ctx := context.Background()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	_, err = tx.Exec(ctx, strings.ReplaceAll(cdcGuardSQL(t), "cdc_reader", role))
	return err
}

func TestCDCGuardFailsLoudlyWithoutTheRoleLive(t *testing.T) {
	url := os.Getenv("PROJECTION_MIGRATION_URL")
	if url == "" {
		t.Skip("PROJECTION_MIGRATION_URL unavailable")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	if err := silentLegacyBlock(t, conn); err != nil {
		t.Fatalf("expected 000009 to skip silently (the R1 weakness this guard closes): %v", err)
	}
	err = runGuard(t, conn, "cdc_reader_absent_r1")
	if err == nil || !strings.Contains(err.Error(), "cdc_reader_absent_r1") {
		t.Fatalf("migration without the CDC role did not fail loudly: %v", err)
	}
	if err := runGuard(t, conn, "cdc_reader"); err != nil {
		t.Fatalf("guard is not idempotent with the role present: %v", err)
	}
	var policy, canSelect bool
	if err := conn.QueryRow(ctx, `SELECT
		EXISTS(SELECT 1 FROM pg_policies WHERE tablename='outbox_events' AND policyname='cdc_outbox_snapshot'
		  AND cmd='SELECT' AND roles = '{cdc_reader}'),
		has_table_privilege('cdc_reader', 'public.outbox_events', 'SELECT')`).Scan(&policy, &canSelect); err != nil {
		t.Fatal(err)
	}
	if !policy || !canSelect {
		t.Fatalf("applied database lacks the snapshot policy=%v select=%v", policy, canSelect)
	}
	var writes bool
	if err := conn.QueryRow(ctx, `SELECT has_table_privilege('cdc_reader', 'public.outbox_events', 'INSERT,UPDATE,DELETE')`).Scan(&writes); err != nil || writes {
		t.Fatalf("cdc_reader can write the outbox: %v %v", writes, err)
	}
}

// silentLegacyBlock runs 000009's conditional grant block with the role absent; it succeeds
// without granting anything, which is why 000012 exists.
func silentLegacyBlock(t *testing.T, conn *pgx.Conn) error {
	t.Helper()
	body, err := files.ReadFile("000009_notification_outbox.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	legacy := string(body)
	start, end := strings.Index(legacy, "DO $$ BEGIN"), strings.Index(legacy, "END $$;\nCREATE PUBLICATION")
	if start < 0 || end < start {
		t.Fatal("000009 grant block not found")
	}
	ctx := context.Background()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	_, err = tx.Exec(ctx, strings.ReplaceAll(legacy[start:end+len("END $$;")], "cdc_reader", "cdc_reader_absent_r1"))
	return err
}
