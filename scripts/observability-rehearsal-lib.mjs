const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

// alert (platform.yaml) -> target control that makes its expression true.
export const SCENARIOS = [
  { alert: "ObservabilityTargetDown", control: "target-down" },
  { alert: "KafkaBrokerUnavailable", control: "kafka-brokers-zero" },
  { alert: "KafkaExporterTargetDown", control: "kafka-exporter-down" },
  { alert: "KafkaOfflinePartitions", control: "kafka-offline-partition" },
  {
    alert: "KafkaUnderReplicatedPartitions",
    control: "kafka-under-replicated",
  },
  { alert: "KafkaConsumerGroupLagHigh", control: "kafka-group-lag-high" },
  { alert: "KafkaConsumerGroupStalled", control: "kafka-group-stalled" },
  { alert: "KafkaConsumerGroupNoMembers", control: "kafka-group-no-members" },
  { alert: "KafkaTopicRetainedMessagesHigh", control: "kafka-topic-retained" },
  { alert: "BindingFeedAgeWarning", control: "binding-age-warning" },
  { alert: "BindingFeedAgeCritical", control: "binding-age-critical" },
  { alert: "BindingConsumerQuarantine", control: "binding-quarantine" },
  { alert: "BindingFeedClockSkew", control: "binding-clock-skew" },
  { alert: "CDCQuarantinedRecords", control: "cdc-quarantine" },
  { alert: "KafkaConnectUnreachable", control: "connect-unreachable" },
  { alert: "KafkaConnectConnectorFailed", control: "connect-connector-failed" },
  { alert: "KafkaConnectTaskFailed", control: "connect-task-failed" },
  { alert: "KafkaConnectConnectorPaused", control: "connect-paused" },
  { alert: "SchemaRegistryDown", control: "schema-registry-down" },
  { alert: "RabbitMQTaskBacklog", control: "rabbit-backlog" },
  { alert: "ReplicationSlotInactive", control: "slot-inactive" },
  { alert: "ReplicationSlotInactiveCritical", control: "slot-inactive" },
  { alert: "ReplicationSlotWALRetainedWarning", control: "slot-wal-warning" },
  { alert: "ReplicationSlotWALRetainedCritical", control: "slot-wal-critical" },
  { alert: "ReplicationSlotWALCapUnbounded", control: "slot-cap-unbounded" },
  {
    alert: "ReplicationSlotWALStatusDegraded",
    control: "slot-status-degraded",
  },
  { alert: "RabbitMQDeadLetterQueueNotEmpty", control: "rabbit-dlq" },
  { alert: "RabbitMQNoConsumers", control: "rabbit-no-consumers" },
  { alert: "RabbitMQUnackedHigh", control: "rabbit-unacked" },
  { alert: "RabbitMQRetryQueueBacklog", control: "rabbit-retry-backlog" },
  { alert: "RabbitMQPublishConfirmFailures", control: "rabbit-publish-failed" },
  { alert: "RabbitMQUnconfirmedMessages", control: "rabbit-unconfirmed" },
  { alert: "RabbitMQMemoryAlarm", control: "rabbit-memory-alarm" },
  { alert: "RabbitMQDiskAlarm", control: "rabbit-disk-alarm" },
  { alert: "RabbitMQMemoryHigh", control: "rabbit-memory-high" },
  { alert: "RabbitMQDiskLow", control: "rabbit-disk-low" },
  { alert: "JobsDispatchDeadRecords", control: "jobs-dispatch-dead" },
  { alert: "IntegrityProjectionQuarantined", control: "projection-quarantine" },
  { alert: "IntegrityJobsDLQPublishFailed", control: "rabbit-publish-failed" },
  { alert: "IntegrityCDCQuarantined", control: "cdc-quarantine" },
  { alert: "APIHighServerErrorRate", control: "api-errors" },
  {
    alert: "ProjectionFreshnessUnknown",
    control: "projection-freshness-unknown",
  },
  { alert: "CDCCommitLagGrowing", control: "cdc-commit-lag" },
  { alert: "DebeziumConnectorMissing", control: "debezium-missing" },
  { alert: "DebeziumConnectorDisconnected", control: "debezium-disconnected" },
  { alert: "DebeziumSourceLagHigh", control: "debezium-lag" },
  { alert: "ProjectionPendingRecords", control: "projection-pending" },
  { alert: "JobsDispatchLagHigh", control: "jobs-dispatch-lag" },
  { alert: "PostgresClientPoolWaiters", control: "pool-waiters" },
  { alert: "PostgresPoolExhaustion", control: "pool-exhaustion" },
  { alert: "PostgresSlowQueryRateHigh", control: "slow-queries" },
  { alert: "SLOBurnRateFastPage", control: "slo-burn-fast" },
  { alert: "SLOBurnRateSlowPage", control: "slo-burn-fast" },
  { alert: "SLOBurnRateFastTicket", control: "slo-burn-fast" },
  { alert: "SLOBurnRateSlowTicket", control: "slo-burn-fast" },
];

export function scaleDuration(text, factor, minimumSeconds = 1) {
  const [, amount, unit] = /^(\d+)([smhdw])$/.exec(text);
  const seconds = Math.max(
    minimumSeconds,
    Math.round((amount * UNIT_SECONDS[unit]) / factor),
  );
  return `${seconds}s`;
}

// Scales evaluation intervals, `for:` durations and [range] selectors in an
// isolated test copy; rule expressions, labels and annotations stay intact.
export function scaleRulesText(
  text,
  factor,
  { excludeAlerts = [], minRangeSeconds = 1 } = {},
) {
  const excluded = new Set(excludeAlerts);
  let skipping = false;
  const selected = text
    .split("\n")
    .filter((line) => {
      const alert = /^[ ]{6}- alert: (\S+)/.exec(line);
      if (alert) skipping = excluded.has(alert[1]);
      else if (/^[ ]{2}- name:/.test(line)) skipping = false;
      return !skipping;
    })
    .join("\n");
  return selected
    .replace(/^(\s*interval:\s*)\d+[smhdw]\s*$/gm, (_, head) => `${head}1s`)
    .replace(
      /^(\s*for:\s*)(\d+[smhdw])\s*$/gm,
      (_, head, d) => `${head}${scaleDuration(d, factor)}`,
    )
    .replace(
      /\[(\d+[smhdw])\]/g,
      (_, d) => `[${scaleDuration(d, factor, minRangeSeconds)}]`,
    );
}

export function forSeconds(scaledText, alert) {
  const block = scaledText.split(`alert: ${alert}\n`)[1] ?? "";
  const match = /for:\s*(\d+)s/.exec(block);
  return match ? Number(match[1]) : 0;
}

export function rehearsalAlertmanager(text, webhookUrl) {
  return text.replace(/^(\s*-?\s*url:\s*).+$/m, `$1${webhookUrl}`);
}

export function prometheusConfig({ targetPort }) {
  return `global:
  scrape_interval: 1s
  evaluation_interval: 1s
rule_files:
  - /etc/prometheus/rules/*.yaml
alerting:
  alertmanagers:
    - static_configs:
        - targets: [alertmanager:9093]
scrape_configs:
  - job_name: rehearsal-target
    honor_labels: true
    static_configs:
      - targets: [host.docker.internal:${targetPort}]
  - job_name: kafka-exporter
    metrics_path: /kafka-metrics
    static_configs:
      - targets: [host.docker.internal:${targetPort}]
  - job_name: kafka-connect-jmx
    metrics_path: /connect-metrics
    static_configs:
      - targets: [host.docker.internal:${targetPort}]
  - job_name: rabbitmq-rehearsal
    metrics_path: /rabbit-metrics
    static_configs:
      - targets: [host.docker.internal:${targetPort}]
  - job_name: postgres-slots-rehearsal
    metrics_path: /slot-metrics
    static_configs:
      - targets: [host.docker.internal:${targetPort}]
`;
}

export function formatTable(rows) {
  const head =
    "| Alert | Control | Pending (s) | Firing (s) | Notified (s) | Resolved (s) | Result |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- |";
  const fmt = (v) => (v == null ? "-" : v.toFixed(1));
  const body = rows.map(
    (r) =>
      `| ${r.alert} | ${r.control} | ${fmt(r.pending)} | ${fmt(r.firing)} | ${fmt(r.notified)} | ${fmt(r.resolved)} | ${r.error ?? "OK"} |`,
  );
  return [head, sep, ...body].join("\n");
}

// The Debezium lag alert selects a metric by name; read it from the rule so
// the synthetic target always exports the series the real expression uses.
export function lagMetricName(rule) {
  return /^(\w+)\s*>/.exec(rule?.expr ?? "")?.[1];
}
