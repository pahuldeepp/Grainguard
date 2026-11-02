// Additional live assertions for STAGE06_FLINK=1. Uses real Kafka, CDC, SQL and
// RabbitMQ; notification delivery uses the local provider (no external messages).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { anomalyDuplicateCount } from "./flink-risk-helpers.mjs";
import { checkPostgresRecovery } from "./flink-risk-postgres-fault.mjs";

export async function checkFlinkIntegration(ctx) {
  const started = new Date().toISOString();
  const runId = randomUUID();
  const sourceHashes = Object.fromEntries(
    [
      "services/risk-engine/risk_engine/apply.py",
      "services/risk-engine/risk_engine/store.py",
      "services/risk-engine/risk_engine/events.py",
      "services/workflow-alerts/src/consumer/handler.ts",
      "services/workflow-alerts/src/alerts/policy.ts",
      "services/workflow-alerts/src/alerts/lifecycle.ts",
      "scripts/stage06-e2e.mjs",
      "scripts/flink-risk-assertions.mjs",
      "scripts/flink-risk-helpers.mjs",
      "scripts/flink-risk-postgres-fault.mjs",
    ].map((file) => [
      file,
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    ]),
  );
  const checks = [];
  let failure = null;
  try {
    await runFlinkIntegration(ctx, (name) => {
      checks.push({ name, ok: true, at: new Date().toISOString() });
      console.log(`PASS Flink integration: ${name}`);
    });
    assert.equal(checks.length, 8, "all integration scenarios must complete");
  } catch (error) {
    failure = error.message;
    throw error;
  } finally {
    mkdirSync("evidence/flink", { recursive: true });
    const evidence = {
      runId,
      started,
      finished: new Date().toISOString(),
      status: failure ? "failed" : "passed",
      error: failure,
      composeProject: "gg-flink-risk",
      notificationProvider: "local",
      maxOutOfOrder: process.env.FLINK_MAX_OUT_OF_ORDER,
      checkpointInterval: process.env.FLINK_CHECKPOINT_INTERVAL,
      latestFixtureObservation: new Date(ctx.maxObservedAt()).toISOString(),
      baseStage06: "passed before Flink assertions",
      expectedChecks: 8,
      checks,
      passed: checks.length,
      sourceHashes,
    };
    const file = `evidence/flink/risk-integration-${runId}.json`;
    const contents = JSON.stringify(evidence, null, 2) + "\n";
    writeFileSync(file, contents);
    writeFileSync("evidence/flink/risk-integration.json", contents);
    console.log(`Flink integration evidence: ${file}`);
  }
}

async function runFlinkIntegration(ctx, passed) {
  const {
    query,
    send,
    stream,
    envelope,
    until,
    start,
    stop,
    tenants,
    riskGroup,
  } = ctx;
  assert.equal(
    process.env.STAGE06_KAFKA_BROKER,
    "127.0.0.1:59112",
    "outage tests require the dedicated stack",
  );
  const anomalies = new Map();
  const anomalyWireValues = new Map();
  // The production consumer supports Flink's LZ4 records. Read its durable
  // inbox receipts, preserving the exact source events for Kafka replay.
  await until("capture durable real Flink anomalies", async () => {
    const rows = await query(
      "risk",
      "SELECT event::text AS wire_value FROM consumer_inbox WHERE tenant_id=ANY($1::uuid[])" +
        " AND source_topic='greenguard.telemetry.anomaly.v1' AND event_type='telemetry.anomaly'",
      [tenants.map((s) => s.tenant)],
    );
    for (const { wire_value } of rows) {
      const event = JSON.parse(wire_value);
      anomalies.set(event.event_id, event);
      // Preserve numeric JSON values such as 28.0. A JS stringify round trip
      // changes them to 28 and no longer reproduces the original payload digest.
      anomalyWireValues.set(event.event_id, wire_value);
    }
    return tenants.every((s) =>
      [...anomalies.values()].some((e) => e.tenant_id === s.tenant),
    );
  });
  for (const s of tenants) {
    const assessments = await query(
      "risk",
      "SELECT source_kind, score FROM risk_assessments WHERE tenant_id=$1 ORDER BY aggregate_version",
      [s.tenant],
    );
    assert.equal(
      assessments.filter((r) => r.source_kind === "anomaly").length,
      1,
    );
    assert.ok(
      assessments
        .filter((r) => r.source_kind === "threshold")
        .every((r) => r.score < 50),
    );
    assert.equal(
      assessments.find((r) => r.source_kind === "anomaly").score,
      50,
    );
    await until(
      "both local farmer channels delivered",
      async () =>
        (
          await query(
            "notifications",
            "SELECT count(*)::int n FROM deliveries WHERE tenant_id=$1 AND status='sent'",
            [s.tenant],
          )
        )[0].n === 2,
    );
  }
  passed(
    "two tenants: real Flink anomalies alone make sub-threshold readings alert-eligible and deliver email plus SMS",
  );
  const count = async (database, table, tenant) =>
    (
      await query(
        database,
        `SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`,
        [tenant],
      )
    )[0].n;
  const snapshots = await Promise.all(
    tenants.map(async (s) => ({
      assessments: await count("risk", "risk_assessments", s.tenant),
      decisions: await count("risk", "anomaly_decisions", s.tenant),
      deliveries: await count("notifications", "deliveries", s.tenant),
    })),
  );
  ctx.riskProcess.kill("SIGKILL");
  await stop(ctx.riskProcess);
  const startRisk = (flag, group = riskGroup) =>
    start(
      "risk-restarted",
      path.resolve(".local/risk-venv/bin/python"),
      ["-m", "risk_engine.main"],
      "services/risk-engine",
      {
        KAFKA_BROKERS: process.env.STAGE06_KAFKA_BROKER,
        RISK_KAFKA_GROUP: group,
        RISK_KAFKA_OFFSET_RESET: "earliest",
        RISK_HEALTH_PORT: "18086",
        RISK_FLINK_ANOMALIES: flag,
      },
    );
  let riskProcess = startRisk("on");
  await until(
    "risk restarted",
    async () =>
      (await fetch("http://127.0.0.1:18086/readyz").catch(() => null))?.ok,
  );
  for (const event of anomalies.values()) {
    await send(
      "greenguard.telemetry.anomaly.v1",
      event,
      anomalyWireValues.get(event.event_id),
    );
    await send(
      "greenguard.telemetry.anomaly.v1",
      event,
      anomalyWireValues.get(event.event_id),
    );
  }
  await until("durable duplicate metrics", async () => {
    const metrics = await fetch("http://127.0.0.1:18086/metrics").then((r) =>
      r.text(),
    );
    return anomalyDuplicateCount(metrics) >= anomalies.size * 2;
  });
  for (const [i, s] of tenants.entries()) {
    assert.equal(
      await count("risk", "risk_assessments", s.tenant),
      snapshots[i].assessments,
    );
    assert.equal(
      await count("risk", "anomaly_decisions", s.tenant),
      snapshots[i].decisions,
    );
    assert.equal(
      await count("notifications", "deliveries", s.tenant),
      snapshots[i].deliveries,
    );
  }
  passed(
    "risk SIGKILL/restart and Kafka anomaly replay create no extra assessment, decision or notification",
  );

  const original = anomalies.values().next().value;
  const decision = async (event) =>
    (
      await query(
        "risk",
        "SELECT outcome FROM anomaly_decisions WHERE tenant_id=$1 AND anomaly_event_id=$2",
        [event.tenant_id, event.event_id],
      )
    )[0]?.outcome;
  for (const outcome of ["too_old", "binding_mismatch"]) {
    const event = structuredClone(original);
    event.event_id = randomUUID();
    if (outcome === "too_old")
      event.payload.observed_at = new Date(Date.now() - 7200_000).toISOString();
    else event.payload.bin_id = randomUUID();
    await send("greenguard.telemetry.anomaly.v1", event);
    await until(
      `durable ${outcome} audit`,
      async () => (await decision(event)) === outcome,
    );
  }
  const waiting = structuredClone(original);
  const unboundDevice = randomUUID();
  waiting.event_id = randomUUID();
  waiting.aggregate_id = waiting.payload.device_id = unboundDevice;
  const waitingSource = envelope(
    waiting.tenant_id,
    "telemetry.recorded",
    "device_telemetry_stream",
    unboundDevice,
    1,
    {
      reading_id: randomUUID(),
      device_id: unboundDevice,
      site_id: waiting.payload.site_id,
      bin_id: waiting.payload.bin_id,
      binding_version: "1",
      source_message_id: randomUUID(),
      observed_at: waiting.payload.observed_at,
      received_at: waiting.payload.observed_at,
      measurements: { temperature_c: 28 },
    },
  );
  waiting.causation_id = waitingSource.event_id;
  waiting.payload.reading_id = waitingSource.payload.reading_id;
  await send("greenguard.telemetry.anomaly.v1", waiting);
  await until("missing binding pauses anomaly without a receipt", async () => {
    const metrics = await fetch("http://127.0.0.1:18086/metrics").then((r) =>
      r.text(),
    );
    return /risk_not_ready_total\{reason="binding_state_unavailable"\} [1-9]/.test(
      metrics,
    );
  });
  assert.equal(await decision(waiting), undefined);
  await send(
    "greenguard.inventory.device.v1",
    envelope(
      waiting.tenant_id,
      "device.registered",
      "device",
      unboundDevice,
      1,
      {
        device_id: unboundDevice,
        serial_number: `WAIT-${randomUUID()}`,
        site_id: waiting.payload.site_id,
        bin_id: waiting.payload.bin_id,
        status: "active",
        binding_version: "1",
      },
    ),
  );
  await send("greenguard.telemetry.recorded.v1", waitingSource);
  await until(
    "binding arrival resumes and audits the original anomaly",
    async () => (await decision(waiting)) === "no_corroboration",
  );
  passed(
    "stale and mismatched anomalies are audited; missing bindings retry without committing and resume on context arrival",
  );
  // Stop only this test project's Flink containers, leaving every other project alone.
  const containers = [
    "gg-flink-risk-flink-taskmanager-1",
    "gg-flink-risk-flink-jobmanager-1",
  ];
  const docker = (action) => {
    const result = spawnSync("docker", [action, ...containers], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(
      result.status,
      0,
      `docker ${action} test Flink containers failed`,
    );
  };
  docker("stop");
  try {
    for (const flag of ["on", "off"]) {
      if (flag === "off") {
        await stop(riskProcess);
        riskProcess = startRisk("off");
        await until(
          "risk flag rollback ready",
          async () =>
            (await fetch("http://127.0.0.1:18086/readyz").catch(() => null))
              ?.ok,
        );
      }
      const s = stream();
      const time = new Date();
      const iso = (offset) => new Date(time.getTime() + offset).toISOString();
      await send(
        "greenguard.inventory.device.v1",
        envelope(s.tenant, "device.registered", "device", s.device, 1, {
          device_id: s.device,
          serial_number: `OUTAGE-${randomUUID()}`,
          site_id: s.site,
          bin_id: s.bin,
          status: "active",
          binding_version: "1",
        }),
      );
      for (const [version, lot, grain, offset, previous] of [
        [1, s.wheat, "wheat", -3600000, null],
        [2, s.canola, "canola", 3600000, s.wheat],
      ])
        await send(
          "greenguard.inventory.lot.v1",
          envelope(s.tenant, "lot.changed", "bin_occupancy", s.bin, version, {
            bin_id: s.bin,
            site_id: s.site,
            lot_id: lot,
            grain_type: grain,
            variety: null,
            occupancy_version: String(version),
            effective_from: iso(offset),
            previous_lot_id: previous,
          }),
        );
      const reading = (version, temp, humidity) =>
        envelope(
          s.tenant,
          "telemetry.recorded",
          "device_telemetry_stream",
          s.device,
          version,
          {
            reading_id: randomUUID(),
            device_id: s.device,
            site_id: s.site,
            bin_id: s.bin,
            binding_version: "1",
            source_message_id: randomUUID(),
            observed_at: iso(version * 1000),
            received_at: iso(version * 1000),
            measurements: {
              temperature_c: temp,
              relative_humidity_percent: humidity,
            },
          },
        );
      // Warning delivery proves the fallback all the way through RabbitMQ. Critical
      // alerts are routed separately by Stage 10d, so verify their persisted bin state.
      const warningReading = reading(1, 30, 70);
      await send("greenguard.telemetry.recorded.v1", warningReading);
      await until(
        `threshold notification with Flink down, flag=${flag}`,
        async () =>
          (
            await query(
              "notifications",
              "SELECT count(*)::int n FROM deliveries WHERE tenant_id=$1 AND status='sent'",
              [s.tenant],
            )
          )[0].n === 2,
      );
      await send("greenguard.telemetry.recorded.v1", reading(2, 40, 70));
      await until(
        "critical threshold unaffected",
        async () =>
          (
            await query(
              "alerts",
              "SELECT severity, score FROM alert_episodes WHERE tenant_id=$1 AND state='open'",
              [s.tenant],
            )
          )[0]?.severity === "critical",
      );
      assert.equal(await count("risk", "anomaly_decisions", s.tenant), 0);
      if (flag === "on") {
        const delayed = structuredClone(anomalies.values().next().value);
        delayed.event_id = randomUUID();
        delayed.tenant_id = s.tenant;
        delayed.aggregate_id = s.device;
        delayed.causation_id = warningReading.event_id;
        Object.assign(delayed.payload, {
          device_id: s.device,
          site_id: s.site,
          bin_id: s.bin,
          observed_at: iso(1000),
          reading_id: warningReading.payload.reading_id,
        });
        await send("greenguard.telemetry.anomaly.v1", delayed);
        await until(
          "delayed anomaly guarded at risk boundary",
          async () =>
            (
              await query(
                "risk",
                "SELECT outcome FROM anomaly_decisions WHERE tenant_id=$1 AND anomaly_event_id=$2",
                [s.tenant, delayed.event_id],
              )
            )[0]?.outcome === "not_higher",
        );
        // Emulate an advisory already in flight when another device made the bin
        // critical. Stream versions cannot order different devices; the consumer
        // must enforce the bin invariant while holding its own episode lock.
        const sample = (
          await query(
            "risk",
            "SELECT payload FROM outbox_events WHERE tenant_id=$1 AND payload->'reasons' ? 'anomalous_temperature' LIMIT 1",
            [tenants[0].tenant],
          )
        )[0].payload;
        const device = randomUUID();
        const payload = {
          ...sample,
          assessment_id: randomUUID(),
          assessment_version: "1",
          device_id: device,
          bin_id: s.bin,
          lot_id: s.wheat,
          reading_id: randomUUID(),
          source_event_id: randomUUID(),
        };
        const inFlight = envelope(
          s.tenant,
          "risk.assessed",
          "device_risk_stream",
          device,
          1,
          payload,
        );
        inFlight.causation_id = payload.source_event_id;
        const before = (
          await query(
            "alerts",
            "SELECT current_assessment_id FROM alert_episodes WHERE tenant_id=$1 AND state='open'",
            [s.tenant],
          )
        )[0];
        await send("greenguard.risk.assessment.v1", inFlight);
        await until(
          "in-flight cross-device advisory consumed",
          async () =>
            (
              await query(
                "alerts",
                "SELECT count(*)::int n FROM consumer_inbox WHERE tenant_id=$1 AND event_id=$2",
                [s.tenant, inFlight.event_id],
              )
            )[0].n === 1,
        );
        const after = (
          await query(
            "alerts",
            "SELECT severity, score, current_assessment_id FROM alert_episodes WHERE tenant_id=$1 AND state='open'",
            [s.tenant],
          )
        )[0];
        assert.equal(after.severity, "critical");
        assert.equal(after.score, 75);
        assert.equal(after.current_assessment_id, before.current_assessment_id);
        passed(
          "delayed anomaly and in-flight cross-device advisory cannot downgrade or replace a critical bin alert",
        );
      }
      await send("greenguard.telemetry.recorded.v1", reading(3, 20, 50));
      await until(
        "threshold clear unaffected",
        async () =>
          (
            await query(
              "alerts",
              "SELECT state FROM alert_episodes WHERE tenant_id=$1",
              [s.tenant],
            )
          )[0]?.state === "resolved",
      );
      passed(
        `Flink stopped, flag=${flag}: threshold notification, critical escalation and normal clear still work`,
      );
    }
  } finally {
    docker("start");
  }
  await until("Flink job running after outage", async () => {
    const response = await fetch("http://127.0.0.1:58114/jobs/overview", {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (!response?.ok) return false;
    return (await response.json()).jobs.some((job) => job.state === "RUNNING");
  });
  await stop(riskProcess);
  riskProcess = startRisk("on");
  await until(
    "advisory consumer ready after flag restoration",
    async () =>
      (await fetch("http://127.0.0.1:18086/readyz").catch(() => null))?.ok,
  );
  const recovered = stream();
  const recoveryTime = Math.max(Date.now(), ctx.maxObservedAt()) + 5000;
  const observed = (offset) => new Date(recoveryTime + offset).toISOString();
  await send(
    "greenguard.inventory.device.v1",
    envelope(
      recovered.tenant,
      "device.registered",
      "device",
      recovered.device,
      1,
      {
        device_id: recovered.device,
        serial_number: `RECOVER-${randomUUID()}`,
        site_id: recovered.site,
        bin_id: recovered.bin,
        status: "active",
        binding_version: "1",
      },
    ),
  );
  for (const [version, lot, grain, offset, previous] of [
    [1, recovered.wheat, "wheat", -3600_000, null],
    [2, recovered.canola, "canola", 3600_000, recovered.wheat],
  ])
    await send(
      "greenguard.inventory.lot.v1",
      envelope(
        recovered.tenant,
        "lot.changed",
        "bin_occupancy",
        recovered.bin,
        version,
        {
          bin_id: recovered.bin,
          site_id: recovered.site,
          lot_id: lot,
          grain_type: grain,
          variety: null,
          occupancy_version: String(version),
          effective_from: observed(offset),
          previous_lot_id: previous,
        },
      ),
    );
  for (const [version, offset, temperature] of [
    [1, 0, 20],
    [2, 2000, 28],
    [3, 5000, 28],
    [4, 7000, 28],
  ]) {
    await send(
      "greenguard.telemetry.recorded.v1",
      envelope(
        recovered.tenant,
        "telemetry.recorded",
        "device_telemetry_stream",
        recovered.device,
        version,
        {
          reading_id: randomUUID(),
          device_id: recovered.device,
          site_id: recovered.site,
          bin_id: recovered.bin,
          binding_version: "1",
          source_message_id: randomUUID(),
          observed_at: observed(offset),
          received_at: observed(offset),
          measurements: {
            temperature_c: temperature,
            relative_humidity_percent: 50,
          },
        },
      ),
    );
  }
  await until(
    "new real Flink anomaly after restart reaches farmer channels",
    async () =>
      (await count("notifications", "deliveries", recovered.tenant)) === 2,
  );
  const recoveryAssessments = await query(
    "risk",
    "SELECT source_kind, score FROM risk_assessments WHERE tenant_id=$1",
    [recovered.tenant],
  );
  assert.equal(
    recoveryAssessments.filter(
      (a) => a.source_kind === "anomaly" && a.score === 50,
    ).length,
    1,
  );
  assert.ok(
    recoveryAssessments
      .filter((a) => a.source_kind === "threshold")
      .every((a) => a.score < 50),
  );
  passed(
    "Flink restart and flag restoration produce a fresh advisory alert and exactly two local farmer-channel deliveries",
  );
  await checkPostgresRecovery(
    ctx,
    original,
    riskProcess,
    [...tenants.map((s) => s.tenant), recovered.tenant],
    passed,
  );
}
