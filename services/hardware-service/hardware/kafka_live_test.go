package hardware

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/twmb/franz-go/pkg/kgo"
	common "greenguard.local/go-common"
	transport "greenguard.local/kafka-transport"
)

func TestLiveKafkaHardwareCommandResultAndReplay(t *testing.T) {
	if os.Getenv("HARDWARE_KAFKA_LIVE") != "1" {
		t.Skip("set HARDWARE_KAFKA_LIVE=1 with broker and topics running")
	}
	p := pool(t)
	brokers := strings.Split(os.Getenv("KAFKA_BROKERS"), ",")
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	producer := liveClient(t, kgo.SeedBrokers(brokers...))
	defer producer.Close()
	resultClient := liveClient(t, transport.Options(brokers, "hardware-result-live-"+uuid(t), []string{ResultTopic})...)
	defer resultClient.CloseAllowingRebalance()
	commandClient := liveClient(t, transport.Options(brokers, "hardware-command-live-"+uuid(t), []string{CommandTopic})...)
	defer commandClient.CloseAllowingRebalance()
	tenant, asset, device, saga := uuid(t), uuid(t), uuid(t), uuid(t)
	register(t, p, tenant, asset)
	c := newCommand(t, tenant, asset, device, saga, "asset.reserve")
	key := []byte(tenant + ":" + saga)
	produceCommand(ctx, t, producer, key, c)
	produceCommand(ctx, t, producer, key, c)
	workerCtx, workerCancel := context.WithCancel(ctx)
	defer workerCancel()
	publisherCtx, publisherCancel := context.WithCancel(ctx)
	defer publisherCancel()
	publisherDone := make(chan error, 1)
	go func() {
		publisherDone <- (OutboxPublisher{Store: Store{DB: p}, Client: producer, PollInterval: 50 * time.Millisecond}).Run(publisherCtx)
	}()
	workerDone := make(chan error, 1)
	go func() { workerDone <- (Worker{Store: Store{DB: p}, Client: commandClient}).Run(workerCtx) }()
	results := readCommandResults(ctx, t, resultClient, c.CommandID, 2)
	assertDuplicateResults(t, results)
	for _, step := range []string{"asset.configure", "asset.release"} {
		c.CommandID = uuid(t)
		c.Step = step
		c.SagaVersion++
		produceCommand(ctx, t, producer, key, c)
		if step == "asset.configure" {
			ackWhenPending(ctx, t, Store{DB: p}, c)
		}
		awaitStepResult(ctx, t, resultClient, c.CommandID, step)
	}
	awaitResultPublished(ctx, t, p, tenant, results[0].ResultID)
	workerCancel()
	awaitWorkerStopped(t, workerDone)
}

func liveClient(t *testing.T, opts ...kgo.Opt) *kgo.Client {
	t.Helper()
	client, err := kgo.NewClient(opts...)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

// produceCommand publishes one saga command with the tenant:saga partition key.
func produceCommand(ctx context.Context, t *testing.T, producer *kgo.Client, key []byte, c Command) {
	t.Helper()
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := producer.ProduceSync(ctx, &kgo.Record{Topic: CommandTopic, Key: key, Value: data}).FirstErr(); err != nil {
		t.Fatal(err)
	}
}

// assertDuplicateResults requires the duplicated command to yield one identical result.
func assertDuplicateResults(t *testing.T, results []Result) {
	t.Helper()
	if len(results) != 2 || results[0].ResultID == "" || results[0].ResultID != results[1].ResultID || results[0].Outcome != "succeeded" {
		t.Fatalf("duplicate Kafka results: %+v", results)
	}
}

func awaitWorkerStopped(t *testing.T, workerDone <-chan error) {
	t.Helper()
	select {
	case err := <-workerDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not stop")
	}
}

// readCommandResults collects up to n results for commandID, committing each match.
func readCommandResults(ctx context.Context, t *testing.T, client *kgo.Client, commandID string, n int) []Result {
	t.Helper()
	results := []Result{}
	for len(results) < n && ctx.Err() == nil {
		m, err := transport.NextMessage(ctx, client, context.DeadlineExceeded)
		if err != nil {
			t.Fatal(err)
		}
		var r Result
		if err := json.Unmarshal(m.Value, &r); err != nil {
			t.Fatal(err)
		}
		if r.CommandID != commandID {
			continue
		}
		results = append(results, r)
		if err := m.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	return results
}

// ackWhenPending waits for the configure command to be pending, then sends a signed ack.
func ackWhenPending(ctx context.Context, t *testing.T, store Store, c Command) {
	t.Helper()
	for ctx.Err() == nil {
		_, e := store.PendingCommand(ctx, c.TenantID, c.CommandID)
		if e == nil {
			break
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			t.Fatal(e)
		}
		time.Sleep(20 * time.Millisecond)
	}
	ack := messageFor(c, "configured")
	ack.Sign(bytes.Repeat([]byte{0x42}, 32))
	ackData, _ := json.Marshal(ack)
	if _, e := (MQTTDispatcher{Store: store}).HandleAck(ctx, ackTopic(c), ackData); e != nil {
		t.Fatal(e)
	}
}

// awaitStepResult commits every result read and stops at the one for commandID.
func awaitStepResult(ctx context.Context, t *testing.T, client *kgo.Client, commandID, step string) {
	t.Helper()
	for ctx.Err() == nil {
		m, err := transport.NextMessage(ctx, client, context.DeadlineExceeded)
		if err != nil {
			t.Fatal(err)
		}
		var r Result
		if err := json.Unmarshal(m.Value, &r); err != nil {
			t.Fatal(err)
		}
		if err := m.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if r.CommandID != commandID {
			continue
		}
		if r.Outcome != "succeeded" || r.Step != step {
			t.Fatalf("%s result %+v", step, r)
		}
		return
	}
}

func awaitResultPublished(ctx context.Context, t *testing.T, p common.TxStarter, tenant, resultID string) {
	t.Helper()
	for ctx.Err() == nil {
		var count int
		err := common.WithTenantSchema(ctx, p, tenant, "", func(ctx context.Context, tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT count(*) FROM hardware_result_outbox WHERE tenant_id=$1 AND result_id=$2 AND published_at IS NOT NULL`, tenant, resultID).Scan(&count)
		})
		if err != nil {
			t.Fatal(err)
		}
		if count == 1 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}
