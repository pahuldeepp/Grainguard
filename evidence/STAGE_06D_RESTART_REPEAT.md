# Stage 06d RabbitMQ restart repeat — 2026-09-25

Ran `make rabbitmq-test` three consecutive times against the local RabbitMQ container. Each command exited 0. On each run, the Go live suite passed broker restart during dispatch, stable-ID dead-letter replay, and dead-record redrive. The notification-service live suite passed all three tests with zero failures.

Raw outputs: [run 1](stage-06d/rabbitmq-repeat-1.log), [run 2](stage-06d/rabbitmq-repeat-2.log), [run 3](stage-06d/rabbitmq-repeat-3.log).

This repeat exercises the local single-broker restart path. It does not prove a multi-node RabbitMQ failover or production latency SLO.
