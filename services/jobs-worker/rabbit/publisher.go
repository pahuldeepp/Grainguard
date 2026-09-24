package rabbit

import (
	"context"
	"errors"
	"fmt"
	"sync"

	amqp "github.com/rabbitmq/amqp091-go"
)

// ErrNacked means the broker refused responsibility for a message (publisher confirm nack).
var ErrNacked = errors.New("broker nacked the publish")

// Message is one persistent publish. MessageID is the stable intent ID and never changes on
// retry, replay or re-publish after a crash, so consumers can deduplicate by it.
type Message struct {
	Exchange   string
	Key        string
	MessageID  string
	Body       []byte
	Headers    amqp.Table
	Expiration string
}

// Confirm is satisfied by *amqp.DeferredConfirmation.
type Confirm interface {
	WaitContext(ctx context.Context) (bool, error)
}

// Channel is the subset of an AMQP channel this package uses.
type Channel interface {
	Declarer
	Confirm(noWait bool) error
	Qos(prefetchCount, prefetchSize int, global bool) error
	Publish(ctx context.Context, exchange, key string, msg amqp.Publishing) (Confirm, error)
	Consume(queue, consumer string) (<-chan amqp.Delivery, error)
	Get(queue string) (amqp.Delivery, bool, error)
	Close() error
}

// Dialer opens a confirm-mode channel with the topology declared.
type Dialer func(url string) (Channel, func() error, error)

// Publisher publishes with confirms on one lazily (re)connected channel.
type Publisher struct {
	url    string
	dial   Dialer
	mu     sync.Mutex
	ch     Channel
	closer func() error
}

func NewPublisher(url string, dial Dialer) *Publisher {
	if dial == nil {
		dial = Dial
	}
	return &Publisher{url: url, dial: dial}
}

func (p *Publisher) channel() (Channel, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ch != nil {
		return p.ch, nil
	}
	ch, closer, err := p.dial(p.url)
	if err != nil {
		return nil, fmt.Errorf("connect to broker: %w", err)
	}
	p.ch, p.closer = ch, closer
	return ch, nil
}

// reset drops a broken channel so the next publish reconnects.
func (p *Publisher) reset(broken Channel) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ch != broken || p.ch == nil {
		return
	}
	_ = p.closer()
	p.ch, p.closer = nil, nil
}

// Publish returns nil only after the broker confirms the persistent message.
func (p *Publisher) Publish(ctx context.Context, m Message) error {
	ch, err := p.channel()
	if err != nil {
		return err
	}
	exchange := m.Exchange
	if exchange == "" {
		exchange = Exchange
	}
	confirm, err := ch.Publish(ctx, exchange, m.Key, amqp.Publishing{
		DeliveryMode: amqp.Persistent, ContentType: "application/json", MessageId: m.MessageID,
		Headers: m.Headers, Body: m.Body, Expiration: m.Expiration,
	})
	if err != nil {
		p.reset(ch)
		return fmt.Errorf("publish: %w", err)
	}
	acked, err := confirm.WaitContext(ctx)
	if err != nil {
		// Unknown outcome: the message may or may not be queued. The caller keeps the
		// ledger row pending and re-publishes with the same MessageID.
		p.reset(ch)
		return fmt.Errorf("await confirm: %w", err)
	}
	if !acked {
		return ErrNacked
	}
	return nil
}

func (p *Publisher) Close() {
	p.mu.Lock()
	ch := p.ch
	p.mu.Unlock()
	p.reset(ch)
}

type amqpChannel struct{ *amqp.Channel }

func (c amqpChannel) Publish(ctx context.Context, exchange, key string, msg amqp.Publishing) (Confirm, error) {
	return c.PublishWithDeferredConfirmWithContext(ctx, exchange, key, false, false, msg)
}

func (c amqpChannel) Consume(queue, consumer string) (<-chan amqp.Delivery, error) {
	return c.Channel.Consume(queue, consumer, false, false, false, false, nil)
}

func (c amqpChannel) Get(queue string) (amqp.Delivery, bool, error) {
	return c.Channel.Get(queue, false)
}

// Dial connects, enables confirms and declares the topology.
func Dial(url string) (Channel, func() error, error) {
	conn, err := amqp.Dial(url)
	if err != nil {
		return nil, nil, err
	}
	raw, err := conn.Channel()
	if err != nil {
		return nil, nil, errors.Join(err, conn.Close())
	}
	ch := amqpChannel{raw}
	if err := Prepare(ch); err != nil {
		return nil, nil, errors.Join(err, conn.Close())
	}
	return ch, conn.Close, nil
}

// Prepare enables publisher confirms and declares the topology on a fresh channel.
func Prepare(ch Channel) error {
	if err := ch.Confirm(false); err != nil {
		return fmt.Errorf("enable confirms: %w", err)
	}
	return Declare(ch)
}
