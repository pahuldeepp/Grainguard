import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SCENARIOS,
  rehearsalAlertmanager,
  scaleDuration,
  scaleRulesText,
} from "./observability-rehearsal-lib.mjs";
import { createTarget } from "../infra/observability/rehearsal/target.mjs";
import { loadAlerts } from "./observability-runbook-check.mjs";

test("durations scale down but never below one second", () => {
  assert.equal(scaleDuration("5m", 60), "5s");
  assert.equal(scaleDuration("10m", 60), "10s");
  assert.equal(scaleDuration("2m", 60), "2s");
  assert.equal(scaleDuration("30s", 60), "1s");
  assert.equal(scaleDuration("1h", 60), "60s");
});

test("scaling rewrites for and range selectors only", () => {
  const scaled = scaleRulesText(
    "        expr: rate(x[5m]) > 2\n        for: 10m\n        description: waits 10m\n",
    60,
  );
  assert.match(scaled, /rate\(x\[5s\]\) > 2/);
  assert.match(scaled, /for: 10s/);
  assert.match(scaled, /waits 10m/);
});

test("the rehearsal Alertmanager keeps the real routing and swaps the URL", () => {
  const real =
    "route:\n  receiver: sink\nreceivers:\n  - name: sink\n    webhook_configs:\n      - url: http://host.docker.internal:18080/alerts\n        send_resolved: true\n";
  const out = rehearsalAlertmanager(
    real,
    "http://host.docker.internal:29180/a",
  );
  assert.match(out, /url: http:\/\/host.docker.internal:29180\/a/);
  assert.match(out, /send_resolved: true/);
  assert.doesNotMatch(out, /18080/);
});

test("every scenario names a real alert and a target control", async () => {
  const alerts = new Set(
    (await loadAlerts(process.cwd())).map((alert) => alert.alert),
  );
  const target = createTarget();
  for (const scenario of SCENARIOS) {
    assert.ok(alerts.has(scenario.alert), scenario.alert);
    assert.ok(target.scenarios.includes(scenario.control), scenario.control);
  }
});

test("the target flips scenarios and exposes the alert series", () => {
  const target = createTarget();
  assert.match(target.render(), /projection_freshness_seconds/);
  assert.match(target.renderKafka(), /^kafka_brokers 1$/m);
  assert.match(target.renderRabbit(), /messages_ready.* 0$/m);
  assert.match(target.renderSlots(), /slot_name="rehearsal"} 1$/m);
  target.set("rabbit-backlog", true);
  target.set("slot-inactive", true);
  assert.match(target.renderRabbit(), /messages_ready.* 2000$/m);
  assert.match(target.renderSlots(), /slot_name="rehearsal"} 0$/m);
  target.reset();
  target.set("kafka-brokers-zero", true);
  assert.match(target.renderKafka(), /^kafka_brokers 0$/m);
  target.set("kafka-exporter-down", true);
  assert.equal(target.isKafkaExporterDown(), true);
  target.reset();
  assert.equal(target.isKafkaExporterDown(), false);
  target.set("projection-freshness-unknown", true);
  assert.doesNotMatch(target.render(), /projection_freshness_seconds/);
  target.set("cdc-commit-lag", true);
  assert.match(target.render(), /^cdc_commit_lag 500$/m);
  target.reset();
  assert.match(target.render(), /^cdc_commit_lag 0$/m);
  assert.throws(() => target.set("nope", true), /unknown scenario/);
});

test("failing counters only grow while their scenario is active", () => {
  const target = createTarget();
  target.tick();
  const base = target.render();
  target.set("slow-queries", true);
  target.set("cdc-quarantine", true);
  target.tick();
  assert.notEqual(target.render(), base);
  assert.match(target.render(), /^postgres_slow_queries_total [1-9]/m);
  assert.match(target.render(), /^cdc_quarantined_total [1-9]/m);
  target.set("cdc-quarantine", false);
  const quarantines = /^cdc_quarantined_total (\d+)/m.exec(target.render())[1];
  target.tick();
  assert.equal(
    /^cdc_quarantined_total (\d+)/m.exec(target.render())[1],
    quarantines,
  );
});
