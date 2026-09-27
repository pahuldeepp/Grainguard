package hardware

import (
	"bytes"
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
)

const stepConfigure = "asset.configure"

type doneToken struct{ err error }

func (t doneToken) Wait() bool                     { return true }
func (t doneToken) WaitTimeout(time.Duration) bool { return true }
func (t doneToken) Done() <-chan struct{}          { c := make(chan struct{}); close(c); return c }
func (t doneToken) Error() error                   { return t.err }

var _ mqtt.Token = doneToken{}

type recordingPublisher struct {
	mu     sync.Mutex
	topics []string
	ids    []string
}

func (p *recordingPublisher) Publish(topic string, _ byte, _ bool, payload interface{}) mqtt.Token {
	var m ConfigureMessage
	_ = json.Unmarshal(payload.([]byte), &m)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.topics = append(p.topics, topic)
	p.ids = append(p.ids, m.CommandID)
	return doneToken{}
}

func (p *recordingPublisher) saw(commandID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, id := range p.ids {
		if id == commandID {
			return true
		}
	}
	return false
}

// pendingConfigure reserves a fresh asset and leaves its configure receipt pending.
func pendingConfigure(t *testing.T, p *pgxpool.Pool, s Store, tenant string) (Command, Command) {
	t.Helper()
	ctx := context.Background()
	asset, device, saga := uuid(t), uuid(t), uuid(t)
	register(t, p, tenant, asset)
	reserve := newCommand(t, tenant, asset, device, saga, "asset.reserve")
	if r, err := s.Apply(ctx, reserve); err != nil || r.Outcome != "succeeded" {
		t.Fatalf("reserve %+v %v", r, err)
	}
	configure := newCommand(t, tenant, asset, device, saga, stepConfigure)
	configure.SagaVersion = 2
	if r, err := s.Apply(ctx, configure); err != nil || r.Outcome != "pending" {
		t.Fatalf("configure %+v %v", r, err)
	}
	return reserve, configure
}

func receiptOutcome(t *testing.T, p *pgxpool.Pool, c Command) string {
	t.Helper()
	var outcome string
	if err := common.WithTenantSchema(context.Background(), p, c.TenantID, "", func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT outcome FROM hardware_command_receipts WHERE tenant_id=$1 AND command_id=$2`, c.TenantID, c.CommandID).Scan(&outcome)
	}); err != nil {
		t.Fatal(err)
	}
	return outcome
}

func tenantExec(t *testing.T, p *pgxpool.Pool, tenant, query string, args ...any) {
	t.Helper()
	if err := common.WithTenantSchema(context.Background(), p, tenant, "", func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, query, args...)
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestLiveReleaseCancelsPendingConfigure(t *testing.T) {
	p := pool(t)
	s := Store{DB: p}
	ctx := context.Background()
	tenant := uuid(t)
	reserve, configure := pendingConfigure(t, p, s, tenant)
	release := newCommand(t, tenant, reserve.Payload.AssetID, reserve.Payload.DeviceID, reserve.SagaID, "asset.release")
	release.SagaVersion = 3
	if r, err := s.Apply(ctx, release); err != nil || r.Outcome != "succeeded" {
		t.Fatalf("release %+v %v", r, err)
	}
	if got := receiptOutcome(t, p, configure); got != "cancelled" {
		t.Fatalf("pending configure not finalized by release: %s", got)
	}
	ack := NewConfigureAck(configure, bytes.Repeat([]byte{0x42}, 32))
	data, _ := json.Marshal(ack)
	if _, err := (MQTTDispatcher{Store: s}).HandleAck(ctx, ackTopic(configure), data); err == nil {
		t.Fatal("late ack for a released asset was accepted")
	}
	pub := &recordingPublisher{}
	for i := 0; i < 3; i++ {
		if err := (MQTTDispatcher{Store: s, Client: pub}).PublishPending(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if pub.saw(configure.CommandID) {
		t.Fatal("cancelled configure was dispatched")
	}
	if r, err := s.Apply(ctx, configure); err != nil || r.Outcome != "cancelled" {
		t.Fatalf("replayed configure must return the finalized receipt %+v %v", r, err)
	}
}

// More than one batch of orphaned and blocked receipts must not starve a newer
// configuration: orphans are cancelled on claim, blocked ones move to the back.
func TestLiveDispatcherNeverStarvesNewConfigurations(t *testing.T) {
	p := pool(t)
	s := Store{DB: p}
	ctx := context.Background()
	tenant := uuid(t)
	const orphans, blocked = 110, 110
	var orphaned []Command
	for i := 0; i < orphans; i++ {
		reserve, configure := pendingConfigure(t, p, s, tenant)
		// Simulate a receipt orphaned before the release-finalization fix.
		tenantExec(t, p, tenant, `UPDATE hardware_assets SET state='available',owner_saga_id=NULL,device_id=NULL,fencing_token=0 WHERE tenant_id=$1 AND asset_id=$2`, tenant, reserve.Payload.AssetID)
		orphaned = append(orphaned, configure)
	}
	for i := 0; i < blocked; i++ {
		reserve, _ := pendingConfigure(t, p, s, tenant)
		tenantExec(t, p, tenant, `UPDATE hardware_assets SET mqtt_ack_secret=NULL WHERE tenant_id=$1 AND asset_id=$2`, tenant, reserve.Payload.AssetID)
	}
	_, fresh := pendingConfigure(t, p, s, tenant)
	pub := &recordingPublisher{}
	d := MQTTDispatcher{Store: s, Client: pub}
	var backlog int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM hardware_pending_configuration_ids(100)`).Scan(&backlog); err != nil {
		t.Fatal(err)
	}
	// Other suites share the database; bound passes by the whole pending backlog.
	passes := 0
	for ; passes < 20 && !pub.saw(fresh.CommandID); passes++ {
		if err := d.PublishPending(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if !pub.saw(fresh.CommandID) {
		t.Fatalf("fresh configuration starved after %d passes", passes)
	}
	for _, c := range orphaned {
		if got := receiptOutcome(t, p, c); got != "cancelled" {
			t.Fatalf("orphan %s not cancelled: %s", c.CommandID, got)
		}
		if pub.saw(c.CommandID) {
			t.Fatal("orphaned configure was published")
		}
	}
	t.Logf("fresh configuration dispatched on pass %d (orphans=%d blocked=%d, initial batch=%d, batch<=%d)", passes, orphans, blocked, backlog, MaxDispatchBatch)
	// Clean up blocked rows so later suites are not slowed by this fixture.
	tenantExec(t, p, tenant, `UPDATE hardware_command_receipts SET outcome='cancelled' WHERE tenant_id=$1 AND outcome='pending'`, tenant)
}

func TestLiveSelectorClampsBatchAndReturnsIDsOnly(t *testing.T) {
	p := pool(t)
	ctx := context.Background()
	rows, err := p.Query(ctx, `SELECT * FROM hardware_pending_configuration_ids(100000)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		if cols := rows.FieldDescriptions(); len(cols) != 2 {
			t.Fatalf("selector must return only tenant_id and command_id, got %d columns", len(cols))
		}
		n++
	}
	if n > MaxDispatchBatch {
		t.Fatalf("selector returned %d rows", n)
	}
	var visible int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM hardware_command_receipts`).Scan(&visible); err != nil || visible != 0 {
		t.Fatalf("runtime role enumerated receipts without tenant context: %d %v", visible, err)
	}
}
