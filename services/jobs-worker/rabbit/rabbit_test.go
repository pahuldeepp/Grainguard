package rabbit

import (
	"context"
	"errors"
	"testing"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

type fakeConfirm struct {
	acked bool
	err   error
}

func (f fakeConfirm) WaitContext(context.Context) (bool, error) { return f.acked, f.err }

type fakeAck struct{ acks, nacks, requeues int }

func (a *fakeAck) Ack(uint64, bool) error { a.acks++; return nil }
func (a *fakeAck) Nack(_ uint64, _ bool, requeue bool) error {
	a.nacks++
	if requeue {
		a.requeues++
	}
	return nil
}
func (a *fakeAck) Reject(uint64, bool) error { return nil }

type fakeChannel struct {
	published  []amqp.Publishing
	keys       []string
	confirm    fakeConfirm
	publishErr error
	declareErr error
	confirmErr error
	qosErr     error
	consumeErr error
	deliveries chan amqp.Delivery
	gets       []amqp.Delivery
	getErr     error
	declared   []string
	closed     int
}

func (f *fakeChannel) ExchangeDeclare(name, _ string, _, _, _, _ bool, _ amqp.Table) error {
	f.declared = append(f.declared, name)
	return f.declareErr
}
func (f *fakeChannel) QueueDeclare(name string, _, _, _, _ bool, _ amqp.Table) (amqp.Queue, error) {
	f.declared = append(f.declared, name)
	return amqp.Queue{Name: name}, nil
}
func (f *fakeChannel) QueueBind(string, string, string, bool, amqp.Table) error { return nil }
func (f *fakeChannel) Confirm(bool) error                                       { return f.confirmErr }
func (f *fakeChannel) Qos(int, int, bool) error                                 { return f.qosErr }
func (f *fakeChannel) Publish(_ context.Context, _, key string, msg amqp.Publishing) (Confirm, error) {
	if f.publishErr != nil {
		return nil, f.publishErr
	}
	f.published = append(f.published, msg)
	f.keys = append(f.keys, key)
	return f.confirm, nil
}
func (f *fakeChannel) Consume(string, string) (<-chan amqp.Delivery, error) {
	return f.deliveries, f.consumeErr
}
func (f *fakeChannel) Get(string) (amqp.Delivery, bool, error) {
	if f.getErr != nil || len(f.gets) == 0 {
		return amqp.Delivery{}, false, f.getErr
	}
	d := f.gets[0]
	f.gets = f.gets[1:]
	return d, true, nil
}
func (f *fakeChannel) Close() error { f.closed++; return nil }

func dialer(ch *fakeChannel, dials *int, err error) Dialer {
	return func(string) (Channel, func() error, error) {
		*dials++
		if err != nil {
			return nil, nil, err
		}
		return ch, ch.Close, nil
	}
}

func TestPrepareDeclaresEveryObject(t *testing.T) {
	ch := &fakeChannel{}
	if err := Prepare(ch); err != nil {
		t.Fatal(err)
	}
	if len(ch.declared) != 6 {
		t.Fatalf("declared %v", ch.declared)
	}
	if err := Prepare(&fakeChannel{confirmErr: errors.New("no confirms")}); err == nil {
		t.Fatal("confirm error ignored")
	}
	if err := Declare(&fakeChannel{declareErr: errors.New("mismatch")}); err == nil {
		t.Fatal("declare error ignored")
	}
}

func TestQueuesUseQuorumAndAtLeastOnceDeadLettering(t *testing.T) {
	for _, q := range queues() {
		if q.args[queueTypeArg] != quorum {
			t.Fatalf("%s is not quorum", q.name)
		}
		if q.name == TaskQueue && (q.args[deliveryLimitArg] != int32(DeliveryLimit) || q.args[dlxStrategyArg] != atLeastOnce) {
			t.Fatalf("task queue args %v", q.args)
		}
	}
}

func TestPublishWaitsForConfirmAndKeepsMessageID(t *testing.T) {
	ch := &fakeChannel{confirm: fakeConfirm{acked: true}}
	dials := 0
	p := NewPublisher("amqp://x", dialer(ch, &dials, nil))
	for i := 0; i < 2; i++ {
		if err := p.Publish(context.Background(), Message{Key: TaskKey, MessageID: "intent-1", Body: []byte("{}")}); err != nil {
			t.Fatal(err)
		}
	}
	if dials != 1 || len(ch.published) != 2 || ch.published[1].MessageId != "intent-1" || ch.published[0].DeliveryMode != amqp.Persistent {
		t.Fatalf("dials=%d published=%+v", dials, ch.published)
	}
	p.Close()
	if ch.closed != 1 {
		t.Fatal("close did not release the channel")
	}
}

func TestPublishFailuresResetOrReport(t *testing.T) {
	dials := 0
	nack := &fakeChannel{confirm: fakeConfirm{acked: false}}
	if err := NewPublisher("u", dialer(nack, &dials, nil)).Publish(context.Background(), Message{}); !errors.Is(err, ErrNacked) {
		t.Fatalf("nack: %v", err)
	}
	lost := &fakeChannel{confirm: fakeConfirm{err: errors.New("connection closed")}}
	p := NewPublisher("u", dialer(lost, &dials, nil))
	if err := p.Publish(context.Background(), Message{}); err == nil || lost.closed != 1 {
		t.Fatalf("confirm error: %v closed=%d", err, lost.closed)
	}
	broken := &fakeChannel{publishErr: errors.New("channel closed")}
	if err := NewPublisher("u", dialer(broken, &dials, nil)).Publish(context.Background(), Message{}); err == nil || broken.closed != 1 {
		t.Fatalf("publish error: %v", err)
	}
	if err := NewPublisher("u", dialer(nil, &dials, errors.New("refused"))).Publish(context.Background(), Message{}); err == nil {
		t.Fatal("dial error ignored")
	}
	if NewPublisher("u", nil).dial == nil {
		t.Fatal("default dialer missing")
	}
}

func delivery(ack *fakeAck, id string, headers amqp.Table) amqp.Delivery {
	return amqp.Delivery{Acknowledger: ack, MessageId: id, Headers: headers, Body: []byte(`{}`)}
}

func TestConsumeSettlesByHandlerResult(t *testing.T) {
	ack := &fakeAck{}
	ch := &fakeChannel{deliveries: make(chan amqp.Delivery, 3)}
	results := []error{nil, ErrReject, errors.New("database down")}
	for range results {
		ch.deliveries <- delivery(ack, "i", nil)
	}
	close(ch.deliveries)
	n := 0
	err := Consume(context.Background(), ch, TaskQueue, 5, func(context.Context, amqp.Delivery) error {
		n++
		return results[n-1]
	})
	if err == nil || ack.acks != 1 || ack.nacks != 2 || ack.requeues != 1 {
		t.Fatalf("err=%v ack=%+v", err, ack)
	}
}

func TestConsumeStopsOnContextAndSetupErrors(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Consume(ctx, &fakeChannel{deliveries: make(chan amqp.Delivery)}, TaskQueue, 1, nil); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := Consume(ctx, &fakeChannel{qosErr: errors.New("x")}, TaskQueue, 1, nil); err == nil {
		t.Fatal("qos error ignored")
	}
	if err := Consume(ctx, &fakeChannel{consumeErr: errors.New("x")}, TaskQueue, 1, nil); err == nil {
		t.Fatal("consume error ignored")
	}
}

func TestReplayDLQPreservesIntentIDAndCountsReplays(t *testing.T) {
	ack := &fakeAck{}
	src := &fakeChannel{gets: []amqp.Delivery{delivery(ack, "intent-a", amqp.Table{ReplayedHeader: int32(2), "x-death": "gone"}), delivery(ack, "intent-b", nil)}}
	out := &fakeChannel{confirm: fakeConfirm{acked: true}}
	dials := 0
	n, err := ReplayDLQ(context.Background(), NewPublisher("u", dialer(out, &dials, nil)), src, 10, nil)
	if err != nil || n != 2 || ack.acks != 2 {
		t.Fatalf("n=%d err=%v ack=%+v", n, err, ack)
	}
	first := out.published[0]
	if first.MessageId != "intent-a" || first.Headers[ReplayedHeader] != int32(3) || first.Headers["x-death"] != nil || out.keys[0] != TaskKey {
		t.Fatalf("replayed %+v", first)
	}
}

func TestReplayDLQRequeuesWhenPublishFailsAndHonoursLimit(t *testing.T) {
	ack := &fakeAck{}
	src := &fakeChannel{gets: []amqp.Delivery{delivery(ack, "a", nil), delivery(ack, "b", nil)}}
	dials := 0
	n, err := ReplayDLQ(context.Background(), NewPublisher("u", dialer(&fakeChannel{confirm: fakeConfirm{}}, &dials, nil)), src, 10, nil)
	if err == nil || n != 0 || ack.requeues != 1 {
		t.Fatalf("n=%d err=%v ack=%+v", n, err, ack)
	}
	ok := &fakeChannel{confirm: fakeConfirm{acked: true}}
	if n, err = ReplayDLQ(context.Background(), NewPublisher("u", dialer(ok, &dials, nil)), src, 1, nil); err != nil || n != 1 {
		t.Fatalf("limit n=%d err=%v", n, err)
	}
	if _, err = ReplayDLQ(context.Background(), nil, &fakeChannel{getErr: errors.New("x")}, 1, nil); err == nil {
		t.Fatal("get error ignored")
	}
}

func TestLiveDialFailsFast(t *testing.T) {
	start := time.Now()
	if _, _, err := Dial("amqp://nobody:nothing@127.0.0.1:1/"); err == nil {
		t.Fatal("dial to a closed port succeeded")
	}
	if time.Since(start) > 10*time.Second {
		t.Fatal("dial did not fail fast")
	}
}

func TestReplayDLQRedrivesDispatchDeadRecordsInsteadOfRepublishing(t *testing.T) {
	ack := &fakeAck{}
	dead := amqp.Table{DeadSourceHeader: DeadSourceDispatch}
	src := &fakeChannel{gets: []amqp.Delivery{delivery(ack, "intent-d", dead), delivery(ack, "intent-e", dead)}}
	out := &fakeChannel{confirm: fakeConfirm{acked: true}}
	dials := 0
	var redriven []string
	n, err := ReplayDLQ(context.Background(), NewPublisher("u", dialer(out, &dials, nil)), src, 1, func(_ context.Context, d amqp.Delivery) error {
		redriven = append(redriven, d.MessageId)
		return nil
	})
	if err != nil || n != 1 || len(out.published) != 0 || len(redriven) != 1 || ack.acks != 1 {
		t.Fatalf("n=%d err=%v published=%d redriven=%v", n, err, len(out.published), redriven)
	}
	if _, err := ReplayDLQ(context.Background(), nil, src, 1, nil); !errors.Is(err, ErrNoRedriveHandler) || ack.requeues != 1 {
		t.Fatalf("missing handler: %v requeues=%d", err, ack.requeues)
	}
}
