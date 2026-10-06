package hardware

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
)

func uuid(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("HARDWARE_DIRECT_URL")
	if url == "" {
		t.Skip("HARDWARE_DIRECT_URL required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	configureFixturePlacement(t, cfg)
	// Match the sharded/PgBouncer runtime: parameter types are inferred from
	// their Go values, so JSON must be bound as text rather than []byte.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	p, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	if err := p.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	return p
}

func newCommand(t *testing.T, tenant, asset, device, saga, step string) Command {
	t.Helper()
	c := Command{TenantID: tenant, SagaID: saga, CommandID: uuid(t), Step: step, SagaVersion: 1, FencingToken: 1}
	c.Payload.TenantID = tenant
	c.Payload.SagaID = saga
	c.Payload.AssetID = asset
	c.Payload.DeviceID = device
	return c
}

func register(t *testing.T, p *pgxpool.Pool, tenant, asset string) {
	t.Helper()
	ctx := context.Background()
	if err := common.WithTenantSchema(ctx, p, tenant, "", func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO hardware_assets(tenant_id,asset_id,serial_number,mqtt_ack_secret) VALUES($1,$2,$3,$4)`, tenant, asset, uuid(t), bytes.Repeat([]byte{0x42}, 32))
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

// testAckSecret matches the mqtt_ack_secret seeded by register.
var testAckSecret = bytes.Repeat([]byte{0x42}, 32)

// applyExpect applies c and fails with label unless it returns outcome.
func applyExpect(ctx context.Context, t *testing.T, s Store, c Command, outcome, label string) Result {
	t.Helper()
	r, err := s.Apply(ctx, c)
	if err != nil || r.Outcome != outcome {
		t.Fatalf("%s %+v %v", label, r, err)
	}
	return r
}

// reservePendingConfigure reserves the asset and leaves a pending configure command.
func reservePendingConfigure(ctx context.Context, t *testing.T, s Store, tenant, asset, device, saga string) (Command, Result) {
	t.Helper()
	applyExpect(ctx, t, s, newCommand(t, tenant, asset, device, saga, hardwareStepReserve), "succeeded", "reserve")
	c := newCommand(t, tenant, asset, device, saga, hardwareStepConfigure)
	c.SagaVersion = 2
	return c, applyExpect(ctx, t, s, c, "pending", "pending")
}

// signedAck returns a valid device acknowledgement for c.
func signedAck(c Command) []byte {
	ack := messageFor(c, "configured")
	ack.Sign(testAckSecret)
	data, _ := json.Marshal(ack)
	return data
}

func TestLiveLifecycleReplayAndIsolation(t *testing.T) {
	p := pool(t)
	s := Store{DB: p}
	ctx := context.Background()
	tenant, other, asset, device, saga := uuid(t), uuid(t), uuid(t), uuid(t), uuid(t)
	register(t, p, tenant, asset)
	reserve := newCommand(t, tenant, asset, device, saga, "asset.reserve")
	reserve.FencingToken = 2
	r := applyExpect(ctx, t, s, reserve, "succeeded", "reserve")
	again, err := s.Apply(ctx, reserve)
	if err != nil || again.ResultID != r.ResultID {
		t.Fatalf("replay result changed %+v %v", again, err)
	}
	conflict := reserve
	conflict.Payload.DeviceID = uuid(t)
	if _, err := s.Apply(ctx, conflict); err == nil {
		t.Fatal("changed command request accepted")
	}
	configure := newCommand(t, tenant, asset, device, saga, "asset.configure")
	configure.SagaVersion = 2
	if _, err := s.Apply(ctx, configure); !errors.Is(err, ErrStaleCommand) {
		t.Fatalf("stale fencing token accepted: %v", err)
	}
	configure.FencingToken = 2
	applyExpect(ctx, t, s, configure, "pending", "configure should wait for MQTT ack")
	dispatcher := MQTTDispatcher{Store: s}
	if _, err = dispatcher.HandleAck(ctx, ackTopic(configure), signedAck(configure)); err != nil {
		t.Fatal(err)
	}
	applyExpect(ctx, t, s, configure, "succeeded", "ack did not finalize")
	otherClaim := newCommand(t, tenant, asset, uuid(t), uuid(t), "asset.reserve")
	applyExpect(ctx, t, s, otherClaim, "rejected", "competing claim")
	foreign := newCommand(t, other, asset, device, saga, "asset.release")
	applyExpect(ctx, t, s, foreign, "rejected", "cross tenant release")
	release := newCommand(t, tenant, asset, device, saga, "asset.release")
	release.SagaVersion = 3
	release.FencingToken = 2
	applyExpect(ctx, t, s, release, "succeeded", "release")
	applyExpect(ctx, t, s, otherClaim, "rejected", "receipt changed after release")
	newClaim := newCommand(t, tenant, asset, uuid(t), uuid(t), "asset.reserve")
	applyExpect(ctx, t, s, newClaim, "succeeded", "new saga cannot reuse hardware")
	var visible int
	if err := common.WithTenantSchema(ctx, p, other, "", func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM hardware_assets WHERE tenant_id=$1 AND asset_id=$2`, tenant, asset).Scan(&visible)
	}); err != nil || visible != 0 {
		t.Fatalf("RLS leaked asset count=%d err=%v", visible, err)
	}
}

func TestLiveConcurrentReserveOnlyOneWins(t *testing.T) {
	p := pool(t)
	s := Store{DB: p}
	tenant, asset := uuid(t), uuid(t)
	register(t, p, tenant, asset)
	commands := []Command{
		newCommand(t, tenant, asset, uuid(t), uuid(t), "asset.reserve"),
		newCommand(t, tenant, asset, uuid(t), uuid(t), "asset.reserve"),
	}
	var wg sync.WaitGroup
	results := make([]Result, 2)
	errs := make([]error, 2)
	for i := range commands {
		wg.Add(1)
		go func(i int) { defer wg.Done(); results[i], errs[i] = s.Apply(context.Background(), commands[i]) }(i)
	}
	wg.Wait()
	wins := 0
	for i := range results {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		if results[i].Outcome == "succeeded" {
			wins++
		}
	}
	if wins != 1 {
		t.Fatalf("two concurrent claims: %+v", results)
	}
}
