package rabbit

import (
	"context"
	"errors"
	"fmt"

	amqp "github.com/rabbitmq/amqp091-go"
)

// ErrReject marks a message that can never be processed; it is dead-lettered, not requeued.
var ErrReject = errors.New("reject message")

// Handler processes one delivery. It must commit its durable effect before returning nil:
// the delivery is acknowledged only afterwards.
type Handler func(ctx context.Context, d amqp.Delivery) error

// Consume acknowledges each delivery after the handler's durable outcome, dead-letters
// rejects and requeues anything else. It returns when ctx ends or the channel closes.
func Consume(ctx context.Context, ch Channel, queue string, prefetch int, handle Handler) error {
	if err := ch.Qos(prefetch, 0, false); err != nil {
		return fmt.Errorf("qos: %w", err)
	}
	deliveries, err := ch.Consume(queue, "")
	if err != nil {
		return fmt.Errorf("consume %s: %w", queue, err)
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case d, ok := <-deliveries:
			if !ok {
				return errors.New("delivery channel closed")
			}
			if err := settle(d, handle(ctx, d)); err != nil {
				return err
			}
		}
	}
}

func settle(d amqp.Delivery, err error) error {
	switch {
	case err == nil:
		return d.Ack(false)
	case errors.Is(err, ErrReject):
		return d.Nack(false, false)
	default:
		return d.Nack(false, true)
	}
}

// DeadHandler redrives a metadata-only dispatch-dead record in the owning ledger.
type DeadHandler func(ctx context.Context, d amqp.Delivery) error

// ErrNoRedriveHandler stops a replay that meets a dispatch-dead record without a handler.
var ErrNoRedriveHandler = errors.New("dispatch-dead DLQ record needs the jobs database to redrive")

// ReplayDLQ moves up to limit dead-lettered tasks back to the task queue. Each keeps its
// MessageID (the intent ID); the attempt counter restarts and x-replayed is incremented.
// Dispatch-dead records (metadata only) are never re-published as tasks: redrive redrives
// the intent in Postgres by the same ID. A DLQ message is acked only after its effect.
func ReplayDLQ(ctx context.Context, p *Publisher, ch Channel, limit int, redrive DeadHandler) (int, error) {
	replayed := 0
	for replayed < limit {
		d, ok, err := ch.Get(DeadQueue)
		if err != nil || !ok {
			return replayed, err
		}
		if err := replayOne(ctx, p, d, redrive); err != nil {
			return replayed, errors.Join(err, d.Nack(false, true))
		}
		if err := d.Ack(false); err != nil {
			return replayed, err
		}
		replayed++
	}
	return replayed, nil
}

func replayOne(ctx context.Context, p *Publisher, d amqp.Delivery, redrive DeadHandler) error {
	if d.Headers[DeadSourceHeader] == DeadSourceDispatch {
		if redrive == nil {
			return ErrNoRedriveHandler
		}
		return redrive(ctx, d)
	}
	return p.Publish(ctx, Message{Key: TaskKey, MessageID: d.MessageId, Body: d.Body, Headers: replayHeaders(d.Headers)})
}

func replayHeaders(in amqp.Table) amqp.Table {
	out := amqp.Table{AttemptHeader: int32(0), ReplayedHeader: int32(1)}
	if n, ok := in[ReplayedHeader].(int32); ok {
		out[ReplayedHeader] = n + 1
	}
	return out
}
