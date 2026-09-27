import { createServer } from "node:http";

const ROUTE = 'method="POST",route="/v1/devices"';

// Scenario name -> series behaviour. Each flips one alert expression from
// platform.yaml; metric names are copied from the expressions verbatim.
const GAUGES = {
  "cdc-commit-lag": ["cdc_commit_lag", 500],
  "projection-pending": ["projection_pending_records", 5000],
  "jobs-dispatch-lag": ["jobs_dispatch_lag_seconds", 600],
  "pool-waiters": ['postgres_pool_waiting_requests{pool="rehearsal"}', 3],
};
const BROKER_GAUGES = {
  "kafka-offline-partition": [
    'kafka_topic_partition_leader{topic="rehearsal",partition="0"}',
    -1,
  ],
  "kafka-under-replicated": [
    'kafka_topic_partition_under_replicated_partition{topic="rehearsal",partition="0"}',
    1,
  ],
  "kafka-topic-retained": [
    'kafka_topic_partition_current_offset{topic="rehearsal",partition="0"}',
    10000002,
  ],
  "slot-wal-warning": [
    'pg_wal_slot_retained_bytes{slot_name="rehearsal"}',
    600,
  ],
  "slot-wal-critical": [
    'pg_wal_slot_retained_bytes{slot_name="rehearsal"}',
    800,
  ],
  "slot-cap-unbounded": ['pg_wal_slot_cap_bytes{slot_name="rehearsal"}', 0],
  "slot-status-degraded": [
    'pg_wal_slot_status_degraded{slot_name="rehearsal"}',
    1,
  ],
  "rabbit-dlq": [
    'rabbitmq_detailed_queue_messages{queue="notifications.dlq"}',
    1,
  ],
  "rabbit-no-consumers": [
    'rabbitmq_detailed_queue_consumers{queue="notifications.tasks"}',
    0,
  ],
  "rabbit-unacked": [
    'rabbitmq_detailed_queue_messages_unacked{queue="notifications.tasks"}',
    600,
  ],
  "rabbit-retry-backlog": [
    'rabbitmq_detailed_queue_messages{queue="notifications.retry"}',
    101,
  ],
  "rabbit-unconfirmed": ["rabbitmq_channel_messages_unconfirmed", 101],
  "rabbit-memory-high": ["rabbitmq_process_resident_memory_bytes", 81],
  "rabbit-memory-limit": ["rabbitmq_resident_memory_limit_bytes", 100],
  "rabbit-disk-low": ["rabbitmq_disk_space_available_bytes", 100],
  "rabbit-disk-limit": ["rabbitmq_disk_space_available_limit_bytes", 100],
};
const CONTROLS = [
  "target-down",
  "kafka-brokers-zero",
  "kafka-exporter-down",
  "rabbit-backlog",
  "slot-inactive",
  "api-errors",
  "projection-freshness-unknown",
  "pool-exhaustion",
  "slow-queries",
  "debezium-missing",
  "debezium-disconnected",
  "debezium-lag",
  "cdc-quarantine",
  "projection-quarantine",
  "binding-quarantine",
  "binding-clock-skew",
  "kafka-offline-partition",
  "kafka-under-replicated",
  "kafka-group-lag-high",
  "kafka-group-stalled",
  "kafka-group-no-members",
  "kafka-topic-retained",
  "binding-age-warning",
  "binding-age-critical",
  "connect-unreachable",
  "connect-connector-failed",
  "connect-task-failed",
  "connect-paused",
  "schema-registry-down",
  "slot-wal-warning",
  "slot-wal-critical",
  "slot-cap-unbounded",
  "slot-status-degraded",
  "rabbit-dlq",
  "rabbit-no-consumers",
  "rabbit-unacked",
  "rabbit-retry-backlog",
  "rabbit-publish-failed",
  "rabbit-unconfirmed",
  "rabbit-memory-alarm",
  "rabbit-disk-alarm",
  "rabbit-memory-high",
  "rabbit-disk-low",
  "jobs-dispatch-dead",
  "slo-burn-fast",
  ...Object.keys(GAUGES),
];
const DEFAULT_LAG_METRIC =
  "debezium_postgres_streaming_milliseconds_behind_source";

// Serves Debezium-style series on a second path (scraped as job
// kafka-connect-jmx, the job name the Debezium alert expressions select).
function renderConnect(failing, lagMetric) {
  const lines = [];
  if (!failing.has("debezium-missing")) {
    const connected = failing.has("debezium-disconnected") ? 0 : 1;
    lines.push(
      `debezium_postgres_streaming_connected{server="rehearsal"} ${connected}`,
    );
  }
  lines.push(
    `${lagMetric}{server="rehearsal"} ${failing.has("debezium-lag") ? 60000 : 0}`,
  );
  lines.push(
    `greenguard_connect_up ${failing.has("connect-unreachable") ? 0 : 1}`,
  );
  lines.push(
    `greenguard_connect_connector_state{connector="rehearsal",state="FAILED"} ${failing.has("connect-connector-failed") ? 1 : 0}`,
  );
  lines.push(
    `greenguard_connect_task_state{connector="rehearsal",task="0",state="FAILED"} ${failing.has("connect-task-failed") ? 1 : 0}`,
  );
  lines.push(
    `greenguard_connect_connector_state{connector="rehearsal",state="PAUSED"} ${failing.has("connect-paused") ? 1 : 0}`,
  );
  lines.push(
    `greenguard_schema_registry_up ${failing.has("schema-registry-down") ? 0 : 1}`,
  );
  return `${lines.join("\n")}\n`;
}

export function createTarget({ lagMetric = DEFAULT_LAG_METRIC } = {}) {
  const failing = new Set();
  const counters = {
    ok: 0,
    err: 0,
    slow: 0,
    empty: 0,
    cdcQuarantined: 0,
    projectionQuarantined: 0,
    bindingQuarantined: 0,
    bindingClockSkew: 0,
    jobsDlqPublishFailed: 0,
    jobsDispatchDead: 0,
    sloOk: 0,
    sloErr: 0,
    kafkaOffset: 0,
  };
  const gaugeLines = (allGauges = GAUGES) =>
    Object.entries(allGauges).map(
      ([name, [series, bad]]) => `${series} ${failing.has(name) ? bad : 0}`,
    );
  const kafkaMetricLines = () => {
    const lines = gaugeLines(BROKER_GAUGES).filter((line) =>
      line.startsWith("kafka_"),
    );
    const hasLag =
      failing.has("kafka-group-lag-high") ||
      failing.has("kafka-group-stalled") ||
      failing.has("kafka-group-no-members");
    lines.push(
      `kafka_consumergroup_lag_sum{consumergroup="projection-builder",topic="rehearsal"} ${failing.has("kafka-group-lag-high") ? 2000 : hasLag ? 10 : 0}`,
    );
    // Keep the source series present during the healthy baseline so the
    // increase() recording rule has samples before a stalled scenario starts.
    lines.push(
      `kafka_consumergroup_current_offset_sum{consumergroup="projection-builder",topic="rehearsal"} ${counters.kafkaOffset}`,
    );
    lines.push(
      `kafka_consumergroup_members{consumergroup="projection-builder"} ${failing.has("kafka-group-no-members") ? 0 : 1}`,
    );
    if (failing.has("kafka-topic-retained")) {
      lines.push(
        'kafka_topic_partition_oldest_offset{topic="rehearsal",partition="0"} 0',
      );
    }
    return lines;
  };
  return {
    scenarios: CONTROLS,
    failing: () => [...failing],
    isDown: () => failing.has("target-down"),
    isKafkaExporterDown: () => failing.has("kafka-exporter-down"),
    renderKafka() {
      return (
        [
          `kafka_brokers ${failing.has("kafka-brokers-zero") ? 0 : 1}`,
          ...kafkaMetricLines(),
        ].join("\n") + "\n"
      );
    },
    renderRabbit() {
      const lines = [
        `rabbitmq_detailed_queue_messages_ready{queue="notifications.tasks"} ${failing.has("rabbit-backlog") ? 2000 : 0}`,
        `rabbitmq_detailed_queue_messages{queue="notifications.dlq"} ${failing.has("rabbit-dlq") ? 1 : 0}`,
        `rabbitmq_detailed_queue_consumers{queue="notifications.tasks"} ${failing.has("rabbit-no-consumers") ? 0 : 1}`,
        `rabbitmq_detailed_queue_messages_unacked{queue="notifications.tasks"} ${failing.has("rabbit-unacked") ? 600 : 0}`,
        `rabbitmq_detailed_queue_messages{queue="notifications.retry"} ${failing.has("rabbit-retry-backlog") ? 101 : 0}`,
        `rabbitmq_channel_messages_unconfirmed ${failing.has("rabbit-unconfirmed") ? 101 : 0}`,
        `rabbitmq_alarms_memory_used_watermark ${failing.has("rabbit-memory-alarm") ? 1 : 0}`,
        `rabbitmq_alarms_free_disk_space_watermark ${failing.has("rabbit-disk-alarm") ? 1 : 0}`,
        `rabbitmq_process_resident_memory_bytes ${failing.has("rabbit-memory-high") ? 81 : 50}`,
        "rabbitmq_resident_memory_limit_bytes 100",
        `rabbitmq_disk_space_available_bytes ${failing.has("rabbit-disk-low") ? 100 : 300}`,
        "rabbitmq_disk_space_available_limit_bytes 100",
      ];
      return lines.join("\n") + "\n";
    },
    renderSlots() {
      return (
        [
          `pg_wal_slot_active{slot_name="rehearsal"} ${failing.has("slot-inactive") ? 0 : 1}`,
          `pg_wal_slot_retained_bytes{slot_name="rehearsal"} ${failing.has("slot-wal-warning") ? 600 : failing.has("slot-wal-critical") ? 800 : 100}`,
          `pg_wal_slot_cap_bytes{slot_name="rehearsal"} ${failing.has("slot-cap-unbounded") ? 0 : 1000}`,
          `pg_wal_slot_status_degraded{slot_name="rehearsal"} ${failing.has("slot-status-degraded") ? 1 : 0}`,
        ].join("\n") + "\n"
      );
    },
    set(name, on) {
      if (!CONTROLS.includes(name)) throw new Error(`unknown scenario ${name}`);
      if (on) failing.add(name);
      else failing.delete(name);
    },
    reset: () => failing.clear(),
    tick() {
      counters.ok += 10;
      if (failing.has("api-errors")) counters.err += 5;
      if (failing.has("slow-queries")) counters.slow += 5;
      if (failing.has("pool-exhaustion")) counters.empty += 1;
      if (failing.has("cdc-quarantine")) counters.cdcQuarantined += 1;
      if (failing.has("projection-quarantine"))
        counters.projectionQuarantined += 1;
      if (failing.has("binding-quarantine")) counters.bindingQuarantined += 1;
      if (failing.has("binding-clock-skew")) counters.bindingClockSkew += 1;
      if (failing.has("rabbit-publish-failed"))
        counters.jobsDlqPublishFailed += 1;
      if (failing.has("jobs-dispatch-dead")) counters.jobsDispatchDead += 1;
      if (!failing.has("kafka-group-stalled")) counters.kafkaOffset += 10;
      counters.sloOk += 10;
      if (failing.has("slo-burn-fast")) counters.sloErr += 100;
    },
    renderConnect: () => renderConnect(failing, lagMetric),
    render() {
      const lines = [
        `http_server_requests_total{${ROUTE},status_code="201"} ${counters.ok}`,
        `http_server_requests_total{${ROUTE},status_code="500"} ${counters.err}`,
        `postgres_slow_queries_total ${counters.slow}`,
        `postgres_pool_empty_acquire_total{pool="rehearsal"} ${counters.empty}`,
        `cdc_quarantined_total ${counters.cdcQuarantined}`,
        `cdc_quarantined_total{reason="rehearsal"} ${counters.cdcQuarantined}`,
        `projection_quarantined_total ${counters.projectionQuarantined}`,
        `binding_consumer_quarantine_total{reason="rehearsal"} ${counters.bindingQuarantined}`,
        `binding_feed_clock_skew_total ${counters.bindingClockSkew}`,
        `jobs_dlq_publish_failed_total ${counters.jobsDlqPublishFailed}`,
        `jobs_dispatch_dead_total ${counters.jobsDispatchDead}`,
        `http_server_requests_total{job="telemetry-ingest",route="/v1/devices/{deviceId}/readings",status_code="200"} ${counters.sloOk}`,
        `http_server_requests_total{job="telemetry-ingest",route="/v1/devices/{deviceId}/readings",status_code="500"} ${counters.sloErr}`,
        ...gaugeLines(),
        `binding_feed_age_seconds ${failing.has("binding-age-critical") ? 300 : failing.has("binding-age-warning") ? 120 : 10}`,
      ];
      if (!failing.has("projection-freshness-unknown")) {
        lines.push("projection_freshness_seconds 1");
      }
      return `${lines.join("\n")}\n`;
    },
  };
}

function handle(target, req, res) {
  res.setHeader("Content-Type", "text/plain; version=0.0.4");
  const url = new URL(req.url, "http://target");
  if (url.pathname === "/metrics") {
    res.statusCode = target.isDown() ? 503 : 200;
    return res.end(target.isDown() ? "down\n" : target.render());
  }
  if (url.pathname === "/connect-metrics")
    return res.end(target.renderConnect());
  if (url.pathname === "/kafka-metrics") {
    res.statusCode = target.isKafkaExporterDown() ? 503 : 200;
    return res.end(
      target.isKafkaExporterDown() ? "down\n" : target.renderKafka(),
    );
  }
  if (url.pathname === "/rabbit-metrics") return res.end(target.renderRabbit());
  if (url.pathname === "/slot-metrics") return res.end(target.renderSlots());
  if (url.pathname === "/control" && req.method === "POST") {
    const name = url.searchParams.get("scenario");
    try {
      if (name === "reset") target.reset();
      else target.set(name, url.searchParams.get("mode") !== "heal");
    } catch (error) {
      res.statusCode = 400;
      return res.end(`${error.message}\n`);
    }
    return res.end(`${JSON.stringify(target.failing())}\n`);
  }
  res.statusCode = 404;
  return res.end("not found\n");
}

export function serveTarget(target, port, host = "127.0.0.1") {
  const timer = setInterval(() => target.tick(), 1000);
  const server = createServer((req, res) => handle(target, req, res));
  return new Promise((resolve) => {
    server.listen(port, host, () =>
      resolve({
        close: () => {
          clearInterval(timer);
          return new Promise((done) => server.close(done));
        },
      }),
    );
  });
}
