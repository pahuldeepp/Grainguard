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
    sloOk: 0,
    sloErr: 0,
  };
  const gaugeLines = () =>
    Object.entries(GAUGES).map(
      ([name, [series, bad]]) => `${series} ${failing.has(name) ? bad : 0}`,
    );
  return {
    scenarios: CONTROLS,
    failing: () => [...failing],
    isDown: () => failing.has("target-down"),
    isKafkaExporterDown: () => failing.has("kafka-exporter-down"),
    renderKafka() {
      return `kafka_brokers ${failing.has("kafka-brokers-zero") ? 0 : 1}\n`;
    },
    renderRabbit() {
      return `rabbitmq_detailed_queue_messages_ready{queue="notifications.tasks"} ${failing.has("rabbit-backlog") ? 2000 : 0}\n`;
    },
    renderSlots() {
      return `pg_wal_slot_active{slot_name="rehearsal"} ${failing.has("slot-inactive") ? 0 : 1}\n`;
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
        `http_server_requests_total{job="telemetry-ingest",route="/v1/devices/{deviceId}/readings",status_code="200"} ${counters.sloOk}`,
        `http_server_requests_total{job="telemetry-ingest",route="/v1/devices/{deviceId}/readings",status_code="500"} ${counters.sloErr}`,
        ...gaugeLines(),
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
    return res.end(target.isKafkaExporterDown() ? "down\n" : target.renderKafka());
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
