package hardware

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/twmb/franz-go/pkg/kgo"
	transport "greenguard.local/kafka-transport"
)

const (
	CommandTopic  = "greenguard.saga.commands.v1"
	ResultTopic   = "greenguard.saga.results.v1"
	ConsumerGroup = "greenguard.hardware.v1"
)

type Worker struct {
	Store  Store
	Client transport.Client
	Next   func(context.Context) (transport.Message, error)
}

// Run commits a command offset only after its transaction and result publication.
// A crash in between replays the command, and its receipt yields the same result ID.
func (w Worker) Run(ctx context.Context) error {
	for ctx.Err() == nil {
		var message transport.Message
		var err error
		if w.Next != nil {
			message, err = w.Next(ctx)
		} else {
			message, err = transport.NextMessage(ctx, w.Client, errors.New("hardware command offset expired; operator replay required"))
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if err := w.process(ctx, message); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
	}
	return nil
}

func (w Worker) process(ctx context.Context, m transport.Message) error {
	var c Command
	if err := json.Unmarshal(m.Value, &c); err != nil {
		return fmt.Errorf("decode command offset %d: %w", m.Offset, err)
	}
	if !strings.HasPrefix(c.Step, "asset.") {
		return m.Commit(ctx)
	}
	if !valid(c) {
		return fmt.Errorf("invalid hardware command offset %d: %w", m.Offset, ErrInvalidCommand)
	}
	if string(m.Key) != c.TenantID+":"+c.SagaID {
		return fmt.Errorf("command key mismatch offset %d: %w", m.Offset, ErrInvalidCommand)
	}
	result, err := w.Store.Apply(ctx, c)
	if err != nil {
		return err
	}
	// A pending receipt waits for the device; a cancelled one was superseded by a
	// release. Neither produces a saga result on replay.
	if result.Outcome == "pending" || result.Outcome == "cancelled" {
		return m.Commit(ctx)
	}
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}
	if err := w.Store.WithExternalAdmission(ctx, result.TenantID, func() error { return transport.Publish(ctx, w.Client, ResultTopic, m.Key, data, resultHeaders(result)) }); err != nil {
		return fmt.Errorf("publish result: %w", err)
	}
	if err := w.Store.MarkPublished(ctx, result); err != nil {
		return fmt.Errorf("mark result published: %w", err)
	}
	return m.Commit(ctx)
}

// KafkaClient creates a fail-closed consumer with manual offset commits.
func KafkaClient(brokers []string) (*kgo.Client, error) {
	return KafkaClientWithReadiness(brokers, nil)
}

// KafkaClientWithReadiness reports when the consumer group has an assigned
// partition, and clears that signal while ownership is being revoked or lost.
// This is a stronger worker-readiness signal than merely reaching a broker.
func KafkaClientWithReadiness(brokers []string, onAssignment func(bool)) (*kgo.Client, error) {
	return KafkaClientForGroupWithReadiness(brokers, ConsumerGroup, onAssignment)
}

// KafkaClientForGroupWithReadiness isolates independent environments sharing a broker.
func KafkaClientForGroupWithReadiness(brokers []string, group string, onAssignment func(bool)) (*kgo.Client, error) {
	if strings.TrimSpace(group) == "" {
		return nil, errors.New("hardware consumer group required")
	}
	if len(brokers) == 0 {
		return nil, errors.New("KAFKA_BROKERS required")
	}
	extra := []kgo.Opt{}
	if onAssignment != nil {
		extra = append(extra,
			kgo.OnPartitionsAssigned(func(_ context.Context, _ *kgo.Client, assigned map[string][]int32) {
				count := 0
				for _, partitions := range assigned {
					count += len(partitions)
				}
				onAssignment(count > 0)
			}),
			kgo.OnPartitionsRevoked(func(context.Context, *kgo.Client, map[string][]int32) { onAssignment(false) }),
			kgo.OnPartitionsLost(func(context.Context, *kgo.Client, map[string][]int32) { onAssignment(false) }),
		)
	}
	options, err := transport.SecureOptions(brokers, group, []string{CommandTopic}, extra...)
	if err != nil {
		return nil, err
	}
	return kgo.NewClient(options...)
}
