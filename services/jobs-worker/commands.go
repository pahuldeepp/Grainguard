package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"

	amqp "github.com/rabbitmq/amqp091-go"
	common "greenguard.local/go-common"
	"greenguard.local/jobs-worker/rabbit"
)

// dialBroker is swapped in tests.
var dialBroker = rabbit.Dial

// redriveCommand: jobs-worker redrive-dead -reason TEXT [-limit N] [-tenant UUID] [-actor NAME]
func redriveCommand(ctx context.Context, args []string, getenv func(string) string, out io.Writer) error {
	fs := flag.NewFlagSet("redrive-dead", flag.ContinueOnError)
	fs.SetOutput(out)
	opts := RedriveOptions{}
	fs.IntVar(&opts.Limit, "limit", 100, "maximum dead intents to redrive")
	fs.StringVar(&opts.TenantID, "tenant", "", "only redrive this tenant's intents (runs under its RLS)")
	fs.StringVar(&opts.Actor, "actor", getenv("USER"), "who is redriving (recorded in intent_redrives)")
	fs.StringVar(&opts.Reason, "reason", "", "why (required; recorded in intent_redrives)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	db, closeDB, err := operationalDB(ctx, getenv)
	if err != nil {
		return err
	}
	defer closeDB()
	done, err := RedriveDead(ctx, db, opts)
	for _, ref := range done {
		_, _ = fmt.Fprintf(out, "redriven tenant=%s intent=%s\n", ref.TenantID, ref.IntentID)
	}
	_, _ = fmt.Fprintf(out, "redriven %d dead intents\n", len(done))
	return err
}

// dlqReplayCommand: jobs-worker dlq-replay [-limit N]. Task records return to the task queue
// with the same message ID; dispatch-dead records are redriven in Postgres when
// JOBS_DATABASE_URL is set.
func dlqReplayCommand(ctx context.Context, args []string, getenv func(string) string, out io.Writer) error {
	fs := flag.NewFlagSet("dlq-replay", flag.ContinueOnError)
	fs.SetOutput(out)
	limit := fs.Int("limit", 100, "maximum DLQ messages to replay")
	if err := fs.Parse(args); err != nil {
		return err
	}
	url := getenv("RABBITMQ_URL")
	if url == "" || *limit < 1 {
		return errors.New("RABBITMQ_URL and a positive -limit are required")
	}
	var redrive rabbit.DeadHandler
	if getenv("JOBS_DATABASE_URL") != "" || getenv("SHARD_REGISTRY_FILE") != "" {
		db, closeDB, err := operationalDB(ctx, getenv)
		if err != nil {
			return err
		}
		defer closeDB()
		redrive = dlqRedrive(db)
	}
	ch, closer, err := dialBroker(url)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer closer()
	pub := rabbit.NewPublisher(url, dialBroker)
	defer pub.Close()
	n, err := rabbit.ReplayDLQ(ctx, pub, ch, *limit, redrive)
	_, _ = fmt.Fprintf(out, "replayed %d DLQ messages\n", n)
	return err
}

func operationalDB(ctx context.Context, getenv func(string) string) (TxStarter, func(), error) {
	if getenv("SHARD_REGISTRY_FILE") != "" {
		db, err := common.ShardedDBFromEnvironment(getenv, "jobs-worker", "greenguard_jobs", "jobs_app")
		if err != nil {
			return nil, nil, err
		}
		return db, db.Close, nil
	}
	if getenv("JOBS_DATABASE_URL") == "" {
		return nil, nil, errors.New("JOBS_DATABASE_URL or SHARD_REGISTRY_FILE is required")
	}
	db, err := openPool(ctx, getenv("JOBS_DATABASE_URL"))
	if err != nil {
		return nil, nil, err
	}
	return db, db.Close, nil
}

// dlqRedrive redrives the intent named by a dispatch-dead DLQ record (same intent_id).
func dlqRedrive(db TxStarter) rabbit.DeadHandler {
	return func(ctx context.Context, d amqp.Delivery) error {
		var rec DeadRecord
		if err := json.Unmarshal(d.Body, &rec); err != nil {
			return err
		}
		if rec.IntentID != d.MessageId {
			return errors.New("dead record intent_id differs from message id")
		}
		_, err := redriveOne(ctx, db, DeadRef{TenantID: rec.TenantID, IntentID: rec.IntentID}, "dlq-replay", "replayed from notifications.dlq", &rec.DeliveryGeneration)
		return err
	}
}
