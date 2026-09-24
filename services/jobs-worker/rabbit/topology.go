// Package rabbit holds the RabbitMQ side of Stage 06d: topology, confirmed publishing,
// manual-ack consumption and DLQ replay. RabbitMQ carries retryable delivery tasks only;
// the authoritative state is the jobs and notifications ledgers.
package rabbit

import amqp "github.com/rabbitmq/amqp091-go"

// Topology names. notification-service declares the same objects with identical arguments
// (services/notification-service/src/topology.ts); a mismatch fails with PRECONDITION_FAILED.
const (
	Exchange       = "greenguard.notifications"
	DeadExchange   = "greenguard.notifications.dlx"
	TaskQueue      = "notifications.tasks"
	RetryQueue     = "notifications.retry"
	DeadQueue      = "notifications.dlq"
	ReceiptQueue   = "notifications.receipts"
	TaskKey        = "task"
	RetryKey       = "retry"
	ReceiptKey     = "receipt"
	DeadKey        = "notifications.dead"
	AttemptHeader  = "x-attempt"
	ReplayedHeader = "x-replayed"
	DeliveryLimit  = 5
	// DeadSourceHeader marks DLQ records by origin; dispatch-dead records hold metadata only
	// and are redriven in Postgres, never re-published as tasks.
	DeadSourceHeader   = "x-dead-source"
	DeadSourceDispatch = "jobs-dispatch"
	quorum             = "quorum"
	queueTypeArg       = "x-queue-type"
	dlxArg             = "x-dead-letter-exchange"
	dlxKeyArg          = "x-dead-letter-routing-key"
	dlxStrategyArg     = "x-dead-letter-strategy"
	overflowArg        = "x-overflow"
	atLeastOnce        = "at-least-once"
	rejectPublish      = "reject-publish"
	deliveryLimitArg   = "x-delivery-limit"
)

type queueSpec struct {
	name, exchange, key string
	args                amqp.Table
}

// Queues are durable quorum queues (supported on a single node since RabbitMQ 3.8). The
// task and retry queues dead-letter at-least-once, which requires reject-publish overflow.
// x-delivery-limit moves a message that keeps crashing its consumer to the DLQ.
func queues() []queueSpec {
	return []queueSpec{
		{TaskQueue, Exchange, TaskKey, amqp.Table{queueTypeArg: quorum, dlxArg: DeadExchange, dlxKeyArg: DeadKey, dlxStrategyArg: atLeastOnce, overflowArg: rejectPublish, deliveryLimitArg: int32(DeliveryLimit)}},
		// No consumer: a per-message expiration is the backoff; on expiry it returns to tasks.
		{RetryQueue, Exchange, RetryKey, amqp.Table{queueTypeArg: quorum, dlxArg: Exchange, dlxKeyArg: TaskKey, dlxStrategyArg: atLeastOnce, overflowArg: rejectPublish}},
		{DeadQueue, DeadExchange, DeadKey, amqp.Table{queueTypeArg: quorum}},
		{ReceiptQueue, Exchange, ReceiptKey, amqp.Table{queueTypeArg: quorum, dlxArg: DeadExchange, dlxKeyArg: DeadKey}},
	}
}

// Declarer is the part of *amqp.Channel topology declaration needs.
type Declarer interface {
	ExchangeDeclare(name, kind string, durable, autoDelete, internal, noWait bool, args amqp.Table) error
	QueueDeclare(name string, durable, autoDelete, exclusive, noWait bool, args amqp.Table) (amqp.Queue, error)
	QueueBind(name, key, exchange string, noWait bool, args amqp.Table) error
}

// Declare creates the exchanges, queues and bindings idempotently.
func Declare(ch Declarer) error {
	for _, ex := range []string{Exchange, DeadExchange} {
		if err := ch.ExchangeDeclare(ex, "direct", true, false, false, false, nil); err != nil {
			return err
		}
	}
	for _, q := range queues() {
		if _, err := ch.QueueDeclare(q.name, true, false, false, false, q.args); err != nil {
			return err
		}
		if err := ch.QueueBind(q.name, q.key, q.exchange, false, nil); err != nil {
			return err
		}
	}
	return nil
}
