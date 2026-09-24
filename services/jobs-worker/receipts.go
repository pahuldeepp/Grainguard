package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	amqp "github.com/rabbitmq/amqp091-go"
	"greenguard.local/jobs-worker/rabbit"
)

// ReceiptHandler applies notification-service receipts to the intent ledger. The delivery
// is acknowledged (by rabbit.Consume) only after the ledger transaction commits.
func ReceiptHandler(db TxStarter, m *Metrics) rabbit.Handler {
	return func(ctx context.Context, d amqp.Delivery) error {
		var r Receipt
		if err := json.Unmarshal(d.Body, &r); err != nil {
			return fmt.Errorf("%w: decode receipt: %v", rabbit.ErrReject, err)
		}
		applied, err := ApplyReceipt(ctx, db, r)
		if errors.Is(err, ErrUnknownOutcome) || errors.Is(err, ErrInvalidTenant) {
			return fmt.Errorf("%w: %v", rabbit.ErrReject, err)
		}
		if err != nil {
			return err
		}
		if applied {
			m.ReceiptsApplied.Add(1)
		} else {
			m.ReceiptsIgnored.Add(1)
		}
		return nil
	}
}
