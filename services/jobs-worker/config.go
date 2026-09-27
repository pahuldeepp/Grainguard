package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Config is read from the environment by run(ctx, getenv) so tests can inject it.
type Config struct {
	DatabaseURL     string
	RabbitURL       string
	KafkaBrokers    []string
	KafkaGroup      string
	AlertsTopic     string
	HTTPAddr        string
	Workers         int
	Batch           int
	ReceiptPrefetch int
	Policy          DispatchPolicy
}

func loadConfig(getenv func(string) string) (Config, error) {
	c := Config{
		DatabaseURL: getenv("JOBS_DATABASE_URL"),
		RabbitURL:   getenv("RABBITMQ_URL"),
		KafkaGroup:  orDefault(getenv("JOBS_KAFKA_GROUP"), "jobs-worker"),
		AlertsTopic: orDefault(getenv("ALERTS_LIFECYCLE_TOPIC"), "greenguard.alerts.lifecycle.v1"),
		HTTPAddr:    orDefault(getenv("JOBS_HTTP_ADDR"), "127.0.0.1:8095"),
	}
	if c.DatabaseURL == "" || c.RabbitURL == "" {
		return c, errors.New("JOBS_DATABASE_URL and RABBITMQ_URL are required")
	}
	if b := getenv("KAFKA_BROKERS"); b != "" {
		c.KafkaBrokers = strings.Split(b, ",")
	}

	var err error
	ints := []struct {
		key  string
		def  int
		dest *int
	}{
		{"JOBS_DISPATCH_WORKERS", 4, &c.Workers},
		{"JOBS_DISPATCH_BATCH", 50, &c.Batch},
		{"JOBS_RECEIPT_PREFETCH", 20, &c.ReceiptPrefetch},
		{"JOBS_MAX_DISPATCH_ATTEMPTS", 8, &c.Policy.MaxAttempts},
	}
	for _, f := range ints {
		if *f.dest, err = positiveInt(getenv(f.key), f.def); err != nil {
			return c, fmt.Errorf("%s: %w", f.key, err)
		}
	}
	c.Policy.BaseBackoff, c.Policy.MaxBackoff, c.Policy.PublishTimeout = time.Second, 5*time.Minute, 5*time.Second
	return c, nil
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func positiveInt(v string, def int) (int, error) {
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		return 0, errors.New("must be a positive integer")
	}
	return n, nil
}
