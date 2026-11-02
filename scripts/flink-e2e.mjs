// Live acceptance for the optional Flink job (ADR-0030): functional semantics, TaskManager loss and
// JobManager loss with checkpoint restore. Isolated: own Compose project (gg-flink), own Kafka, unique
// tenants per run. Prerequisite: `make flink-topics`. Usage: node scripts/flink-e2e.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { checkedResult, dlqForInput } from "./flink-risk-helpers.mjs";

const COMPOSE = [
  "compose",
  "-p",
  "gg-flink",
  "-f",
  "infra/flink/compose.standalone.yaml",
  "-f",
  "infra/flink/compose.yaml",
  "--profile",
  "flink",
];
const KAFKA = "gg-flink-kafka-1";
const UI = `http://127.0.0.1:${process.env.FLINK_UI_PORT ?? "58084"}`;
const INPUT = `greenguard.telemetry.recorded.v1.e2e-${randomUUID()}`;
const T0 = 1_767_225_600_000; // 2026-01-01T00:00:00Z, divisible by the window slide
const MIN = 60_000;
// Watermarks only move forward and downstream operators ignore idle inputs, so a reading older than the stream's
// progress is late by design. Each phase therefore starts later in event time than the previous one.
const BASE_B = T0 + 1000 * MIN;
const BASE_C = T0 + 2000 * MIN;
const SIZE = 10 * MIN;
const SLIDE = 5 * MIN;
const RUN = Math.floor(Math.random() * 90_000) + 10_000;
const results = [];
const evidence = {
  run: RUN,
  started: new Date().toISOString(),
  checks: [],
  timings: {},
};

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const iso = (ms) => new Date(ms).toISOString();
const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
const compose = (args, env = {}) =>
  checkedResult(
    sh("docker", [...COMPOSE, ...args], { env: { ...process.env, ...env } }),
    `owned Compose ${args[0]}`,
  );
const kafka = (args, input) =>
  sh(
    "docker",
    [
      "exec",
      "-i",
      KAFKA,
      `/opt/kafka/bin/${args[0]}`,
      "--bootstrap-server",
      "kafka:29092",
      ...args.slice(1),
    ],
    { input },
  );

function check(name, ok, detail = "") {
  results.push(ok);
  evidence.checks.push({ name, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
  );
}

function event({ tenant, device, id, ms, temp = 20, hum = 50, version }) {
  const m = {};
  if (temp !== null) m.temperature_c = temp;
  if (hum !== null) m.relative_humidity_percent = hum;
  return {
    key: `${tenant}:${device}`,
    value: JSON.stringify({
      event_id: id,
      event_type: "telemetry.recorded",
      schema_version: 1,
      occurred_at: iso(ms),
      tenant_id: tenant,
      aggregate_type: "device_telemetry_stream",
      aggregate_id: device,
      aggregate_version: String(version ?? 1),
      correlation_id: uid(7),
      causation_id: uid(8),
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      payload: {
        reading_id: uid(RUN * 1000 + (version ?? 1)),
        device_id: device,
        site_id: uid(10),
        bin_id: null,
        binding_version: "1",
        source_message_id: `s-${id}`,
        observed_at: iso(ms),
        received_at: iso(ms + 1000),
        measurements: m,
      },
    }),
  };
}

function produce(lines) {
  const input = lines.map((l) => `${l.key}|${l.value}`).join("\n") + "\n";
  const r = kafka(
    [
      "kafka-console-producer.sh",
      "--topic",
      INPUT,
      "--property",
      "parse.key=true",
      "--property",
      "key.separator=|",
    ],
    input,
  );
  if (r.status !== 0)
    throw new Error(`produce failed: ${r.stderr.slice(0, 300)}`);
}

function consume(topic, timeoutMs = 6000) {
  const r = kafka([
    "kafka-console-consumer.sh",
    "--topic",
    topic,
    "--from-beginning",
    "--timeout-ms",
    String(timeoutMs),
    "--property",
    "print.key=true",
    "--property",
    "print.headers=true",
  ]);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [headers, key, ...rest] = line.split("\t");
      const value = rest.join("\t");
      const h = Object.fromEntries(
        headers.split(",").map((p) => {
          const i = p.indexOf(":");
          return [p.slice(0, i), p.slice(i + 1)];
        }),
      );
      try {
        return { headers: h, key, body: JSON.parse(value) };
      } catch {
        return { headers: h, key, body: null, raw: value };
      }
    });
}

async function jobState() {
  try {
    const jobs = (await (await fetch(`${UI}/jobs/overview`)).json()).jobs ?? [];
    const j = jobs.filter((x) => x.state === "RUNNING")[0] ?? jobs[0];
    return j ? { id: j.jid, state: j.state } : null;
  } catch {
    return null;
  }
}

async function waitRunning(timeoutMs = 120_000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const j = await jobState();
    if (j?.state === "RUNNING") {
      const tasks = await (
        await fetch(`${UI}/jobs/${j.id}`)
      )
        .json()
        .catch(() => null);
      if (tasks?.vertices?.every((v) => v.tasks.RUNNING === v.parallelism))
        return Date.now() - t;
    }
    await delay(1000);
  }
  throw new Error("job did not reach RUNNING");
}

async function restartCount() {
  const j = await jobState();
  if (!j) return 0;
  const m = await (
    await fetch(`${UI}/jobs/${j.id}/metrics?get=numRestarts`)
  )
    .json()
    .catch(() => []);
  return Number(m[0]?.value ?? 0);
}

// Recovered = the job restarted at least once more than before AND every task is running again.
async function waitRecovered(restartsBefore, timeoutMs = 240_000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    if ((await restartCount()) > restartsBefore) {
      await waitRunning(timeoutMs - (Date.now() - t));
      return;
    }
    await delay(1000);
  }
  throw new Error("job did not restart and recover");
}

async function completedCheckpoints() {
  const j = await jobState();
  if (!j) return 0;
  const c = await (
    await fetch(`${UI}/jobs/${j.id}/checkpoints`)
  )
    .json()
    .catch(() => null);
  return c?.counts?.completed ?? 0;
}

async function until(fn, timeoutMs, label) {
  const t = Date.now();
  let last;
  while (Date.now() - t < timeoutMs) {
    last = fn();
    if (last.done) return last;
    await delay(4000);
  }
  console.log(`  (timed out waiting for ${label})`);
  return last;
}

// Reference implementation of the windows, independent of the Java code.
function expectedWindows(readings) {
  const seen = new Set();
  const windows = new Map();
  for (const r of readings) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const last = Math.floor(r.ms / SLIDE) * SLIDE;
    for (let s = last; s > r.ms - SIZE; s -= SLIDE) {
      const w = windows.get(s) ?? { count: 0, t: [], h: [] };
      w.count++;
      if (r.temp !== null) w.t.push(r.temp);
      if (r.hum !== null) w.h.push(r.hum);
      windows.set(s, w);
    }
  }
  return windows;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function compareWindows(label, aggs, tenant, device, readings) {
  const want = expectedWindows(readings);
  const got = new Map();
  for (const a of aggs.filter(
    (x) => x.body?.tenant_id === tenant && x.body.payload.device_id === device,
  )) {
    const start = Date.parse(a.body.payload.window_start);
    const prev = got.get(start);
    if (!prev || a.body.payload.revision >= prev.payload.revision)
      got.set(start, a.body);
  }
  let bad = [];
  for (const [start, w] of want) {
    const g = got.get(start);
    if (!g) {
      bad.push(`missing window ${iso(start)}`);
      continue;
    }
    const p = g.payload;
    if (p.reading_count !== w.count)
      bad.push(`${iso(start)} count ${p.reading_count} != ${w.count}`);
    if (w.t.length && Math.abs(p.temperature_c.mean - mean(w.t)) > 1e-5)
      bad.push(`${iso(start)} temp mean`);
    if (
      w.t.length &&
      (p.temperature_c.min !== Math.min(...w.t) ||
        p.temperature_c.max !== Math.max(...w.t))
    )
      bad.push(`${iso(start)} temp min/max`);
    if (
      w.h.length &&
      Math.abs(p.relative_humidity_percent.mean - mean(w.h)) > 1e-5
    )
      bad.push(`${iso(start)} humidity mean`);
  }
  for (const start of got.keys())
    if (!want.has(start)) bad.push(`unexpected window ${iso(start)}`);
  check(
    label,
    bad.length === 0,
    bad.length
      ? bad.slice(0, 3).join("; ")
      : `${want.size} windows match the reference`,
  );
}

async function main() {
  // ---------- start Flink with e2e-friendly time settings and a fresh consumer group
  const env = {
    FLINK_WINDOW_SIZE: "10m",
    FLINK_WINDOW_SLIDE: "5m",
    FLINK_ALLOWED_LATENESS: "5m",
    FLINK_MAX_OUT_OF_ORDER: "1m",
    FLINK_IDLE_TIMEOUT: "5s",
    FLINK_CHECKPOINT_INTERVAL: "3s",
    FLINK_ANOMALY_MIN_SAMPLES: "5",
    FLINK_GROUP_ID: `e2e-${RUN}`,
    FLINK_PARALLELISM: "2",
    FLINK_INPUT_TOPIC: INPUT,
  };
  Object.assign(process.env, env);
  // Isolation: watermarks are global per partition, so leftover far-future events from an earlier run would make
  // this run's events "late". Stop the job, recreate the input topic, then start fresh.
  compose(["stop", "flink-jobmanager", "flink-taskmanager"], env);
  kafka(["kafka-topics.sh", "--delete", "--topic", INPUT, "--if-exists"]);
  await delay(3000);
  const created = kafka([
    "kafka-topics.sh",
    "--create",
    "--topic",
    INPUT,
    "--partitions",
    "6",
    "--replication-factor",
    "1",
  ]);
  if (created.status !== 0)
    throw new Error(
      `could not recreate ${INPUT}: ${created.stderr.slice(0, 200)}`,
    );
  compose(
    ["up", "-d", "--force-recreate", "flink-jobmanager", "flink-taskmanager"],
    env,
  );
  await delay(5000);
  evidence.timings.startToRunningMs = await waitRunning();
  console.log(`job RUNNING after ${evidence.timings.startToRunningMs} ms`);

  // ---------- phase A: functional semantics
  const A = uid(RUN * 10 + 1),
    B = uid(RUN * 10 + 2),
    dev = uid(RUN * 10 + 5);
  const readingsA = [],
    readingsB = [];
  const lines = [];
  for (let i = 0; i < 12; i++) {
    const a = {
      id: uid(RUN * 1000 + i),
      ms: T0 + i * MIN,
      temp: 20 + (i % 2) * 0.05,
      hum: 50,
    };
    const b = {
      id: uid(RUN * 1000 + 100 + i),
      ms: T0 + i * MIN,
      temp: 40,
      hum: 70,
    };
    readingsA.push(a);
    readingsB.push(b);
    lines.push(
      event({ tenant: A, device: dev, ...a, version: i + 1 }),
      event({ tenant: B, device: dev, ...b, version: i + 1 }),
    );
  }
  const spike = {
    id: uid(RUN * 1000 + 50),
    ms: T0 + 13 * MIN,
    temp: 32,
    hum: 50,
  };
  readingsA.push(spike);
  lines.push(event({ tenant: A, device: dev, ...spike, version: 13 }));
  for (const i of [3, 5, 5])
    lines.push(
      event({ tenant: A, device: dev, ...readingsA[i], version: i + 1 }),
    ); // duplicates
  lines.push({ key: `${A}:${dev}`, value: "{not json" });
  lines.push({
    ...event({
      tenant: A,
      device: dev,
      id: uid(RUN * 1000 + 60),
      ms: T0 + 2 * MIN,
    }),
    key: `${B}:${dev}`,
  }); // key mismatch
  lines.push(
    event({
      tenant: A,
      device: dev,
      id: uid(RUN * 1000 + 61),
      ms: T0 + 2 * MIN,
      temp: 500,
    }),
  ); // out of range
  produce(lines);
  // far-future readings flush every window and expire the lateness of the early ones
  const flushA = {
      id: uid(RUN * 1000 + 70),
      ms: T0 + 90 * MIN,
      temp: 20,
      hum: 50,
    },
    flushB = { id: uid(RUN * 1000 + 71), ms: T0 + 90 * MIN, temp: 40, hum: 70 };
  // The flush readings only advance the watermark; their own windows stay open, so they are not in the reference.
  produce([
    event({ tenant: A, device: dev, ...flushA, version: 14 }),
    event({ tenant: B, device: dev, ...flushB, version: 13 }),
  ]);
  await delay(12000);
  const lateId = uid(RUN * 1000 + 80);
  produce([
    event({
      tenant: A,
      device: dev,
      id: lateId,
      ms: T0 + 1 * MIN,
      temp: 20,
      hum: 50,
    }),
  ]); // far beyond allowed lateness

  const wantAgg =
    expectedWindows(readingsA).size + expectedWindows(readingsB).size;
  let state = await until(
    () => {
      const agg = consume("greenguard.telemetry.aggregate.v1").filter((x) =>
        [A, B].includes(x.body?.tenant_id),
      );
      const dlq = consume("greenguard.stream.dlq.v1").filter((x) => x.body);
      const an = consume("greenguard.telemetry.anomaly.v1").filter((x) =>
        [A, B].includes(x.body?.tenant_id),
      );
      const distinct = new Set(
        agg.map(
          (x) =>
            `${x.body.tenant_id}|${Date.parse(x.body.payload.window_start)}`,
        ),
      ).size;
      return {
        done:
          distinct >= wantAgg &&
          an.length >= 1 &&
          dlq.some((d) => d.body.detail?.includes(lateId)),
        agg,
        dlq,
        an,
      };
    },
    150_000,
    "phase A outputs",
  );
  compareWindows(
    "A1 tenant A sliding windows equal the independent reference (duplicates counted once)",
    state.agg,
    A,
    dev,
    readingsA,
  );
  compareWindows(
    "A2 tenant B sliding windows equal the independent reference",
    state.agg,
    B,
    dev,
    readingsB,
  );
  const aOut = state.agg.filter((x) => x.body.tenant_id === A),
    bOut = state.agg.filter((x) => x.body.tenant_id === B);
  check(
    "A3 tenant isolation: key, header and body agree and B never contains A values (same device UUID)",
    state.agg.every(
      (x) =>
        x.key === `${x.body.tenant_id}:${x.body.aggregate_id}` &&
        x.headers.tenant_id === x.body.tenant_id,
    ) &&
      bOut.every((x) => x.body.payload.temperature_c.max === 40) &&
      aOut.every((x) => x.body.payload.temperature_c.max < 40),
  );
  const anA = state.an.filter((x) => x.body.tenant_id === A),
    anB = state.an.filter((x) => x.body.tenant_id === B);
  check(
    "A4 anomaly: one rapid_change for tenant A tied to the causing event, none for tenant B",
    anA.length === 1 &&
      anA[0].body.payload.detector === "rapid_change" &&
      anA[0].body.causation_id === spike.id &&
      anA[0].body.payload.advisory === true &&
      anB.length === 0,
    `A=${anA.length} B=${anB.length}`,
  );
  const dlqMine = dlqForInput(state.dlq, INPUT);
  const reasons = dlqMine.map((d) => d.body.reason);
  check(
    "A5 DLQ holds bad_json, key_mismatch, bad_field and the beyond-lateness event",
    ["bad_json", "key_mismatch", "bad_field", "late"].every((r) =>
      reasons.includes(r),
    ),
    [...new Set(reasons)].join(","),
  );
  check(
    "A6 DLQ records are bounded and carry a validated tenant hint or 'unknown'",
    dlqMine.every(
      (d) =>
        (d.body.raw_base64 ?? "").length <= 87_384 &&
        (/^[0-9a-f-]{36}$/.test(d.headers.tenant_id) ||
          d.headers.tenant_id === "unknown"),
    ),
  );
  const ids = state.agg.map((x) => x.body.event_id);
  check(
    "A7 aggregate event IDs are deterministic (same window, same ID across revisions)",
    new Set(ids).size <= wantAgg + 6 &&
      state.agg.every((x) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          x.body.event_id,
        ),
      ),
  );

  // ---------- phase B: TaskManager loss during processing
  const TA = uid(RUN * 10 + 3),
    TD = uid(RUN * 10 + 6);
  const rb = [];
  const mk = (i, base) => ({
    id: uid(RUN * 1000 + base + i),
    ms: BASE_B + i * MIN,
    temp: 25 + (i % 3) * 0.1,
    hum: 55,
  });
  for (let i = 0; i < 20; i++) rb.push(mk(i, 200));
  produce(
    rb.map((r, i) => event({ tenant: TA, device: TD, ...r, version: i + 1 })),
  );
  await delay(8000);
  const ckptBefore = await completedCheckpoints();
  const restartsBefore = await restartCount();
  const killAt = Date.now();
  sh("docker", ["kill", "gg-flink-flink-taskmanager-1"]);
  // `docker kill` counts as a manual stop, so Docker's restart policy does not bring the container back.
  // An orchestrator (Kubernetes) would; do what it would do after a short outage.
  await delay(3000);
  sh("docker", ["start", "gg-flink-flink-taskmanager-1"]);
  for (let i = 20; i < 40; i++) rb.push(mk(i, 200)); // arrives while the job is down
  produce(
    rb
      .slice(20)
      .map((r, i) => event({ tenant: TA, device: TD, ...r, version: 21 + i })),
  );
  const fl = {
    id: uid(RUN * 1000 + 290),
    ms: BASE_B + 120 * MIN,
    temp: 25,
    hum: 55,
  };
  produce([event({ tenant: TA, device: TD, ...fl, version: 41 })]);
  await delay(4000);
  await waitRecovered(restartsBefore);
  evidence.timings.taskManagerKillToRecoveredMs = Date.now() - killAt;
  console.log(
    `TaskManager killed (container restarted after 3 s); job restarted and RUNNING again ${evidence.timings.taskManagerKillToRecoveredMs} ms after the kill (checkpoints before kill: ${ckptBefore})`,
  );
  state = await until(
    () => {
      const agg = consume("greenguard.telemetry.aggregate.v1").filter(
        (x) => x.body?.tenant_id === TA,
      );
      const distinct = new Set(
        agg.map((x) => Date.parse(x.body.payload.window_start)),
      ).size;
      return { done: distinct >= expectedWindows(rb).size, agg };
    },
    150_000,
    "phase B outputs",
  );
  compareWindows(
    "B1 after a TaskManager kill every window is present and correct (no loss, no double count)",
    state.agg,
    TA,
    TD,
    rb,
  );
  const byId = new Map();
  let conflicting = 0;
  for (const x of state.agg) {
    const k = `${x.body.event_id}|${x.body.payload.revision}`;
    if (byId.has(k) && byId.get(k) !== JSON.stringify(x.body)) conflicting++;
    byId.set(k, JSON.stringify(x.body));
  }
  check(
    "B2 any replayed output is byte-identical to the original (idempotent for downstream inboxes)",
    conflicting === 0,
    `${state.agg.length - byId.size} replayed duplicates`,
  );
  evidence.timings.taskManagerReplayedDuplicates = state.agg.length - byId.size;

  // ---------- phase C: JobManager loss, restore from the newest retained checkpoint
  const CA = uid(RUN * 10 + 4),
    CD = uid(RUN * 10 + 7);
  const rc = [];
  for (let i = 0; i < 20; i++)
    rc.push({
      id: uid(RUN * 1000 + 400 + i),
      ms: BASE_C + i * MIN,
      temp: 30 + (i % 3) * 0.1,
      hum: 60,
    });
  produce(
    rc.map((r, i) => event({ tenant: CA, device: CD, ...r, version: i + 1 })),
  );
  produce([
    event({
      tenant: CA,
      device: CD,
      id: uid(RUN * 1000 + 450),
      ms: BASE_C + 60 * MIN,
      temp: 30,
      hum: 60,
      version: 21,
    }),
  ]);
  rc.push({
    id: uid(RUN * 1000 + 450),
    ms: BASE_C + 60 * MIN,
    temp: 30,
    hum: 60,
  });
  await delay(10000);
  const t0 = Date.now();
  while ((await completedCheckpoints()) < 2 && Date.now() - t0 < 60_000)
    await delay(1000);
  compose(["stop", "flink-jobmanager"]);
  console.log(
    "JobManager stopped (job lost); restoring from the newest retained checkpoint",
  );
  const restoreAt = Date.now();
  const rs = sh(
    "infra/flink/restore.sh",
    [COMPOSE.join(" ").replace(/^/, "docker ")],
    { env: { ...process.env, ...env } },
  );
  check(
    "C1 restore script found a retained checkpoint and restarted the JobManager",
    rs.status === 0,
    (rs.stdout + rs.stderr)
      .split("\n")
      .filter((l) => l.includes("restoring"))
      .join(" ")
      .slice(0, 160),
  );
  await delay(5000);
  evidence.timings.jobManagerRestoreToRunningMs = await waitRunning(
    180_000,
  ).then(() => Date.now() - restoreAt);
  console.log(
    `job RUNNING again ${evidence.timings.jobManagerRestoreToRunningMs} ms after restore`,
  );
  const resent = rc[4];
  const fresh = [];
  for (let i = 20; i < 30; i++) {
    const r = {
      id: uid(RUN * 1000 + 400 + i),
      ms: BASE_C + (61 + i) * MIN,
      temp: 30,
      hum: 60,
    };
    fresh.push(r);
    rc.push(r);
  }
  produce([event({ tenant: CA, device: CD, ...resent, version: 5 })]); // replayed pre-failure event: dedupe state must have been restored
  produce(
    fresh.map((r, i) =>
      event({ tenant: CA, device: CD, ...r, version: 22 + i }),
    ),
  );
  const fl2 = {
    id: uid(RUN * 1000 + 499),
    ms: BASE_C + 200 * MIN,
    temp: 30,
    hum: 60,
  };
  produce([event({ tenant: CA, device: CD, ...fl2, version: 32 })]);
  state = await until(
    () => {
      const agg = consume("greenguard.telemetry.aggregate.v1").filter(
        (x) => x.body?.tenant_id === CA,
      );
      const distinct = new Set(
        agg.map((x) => Date.parse(x.body.payload.window_start)),
      ).size;
      return { done: distinct >= expectedWindows(rc).size, agg };
    },
    150_000,
    "phase C outputs",
  );
  compareWindows(
    "C2 after JobManager loss and restore, windows are complete and correct",
    state.agg,
    CA,
    CD,
    rc,
  );
  const dlq = consume("greenguard.stream.dlq.v1").filter((d) =>
    d.body?.detail?.includes(resent.id),
  );
  check(
    "C3 a pre-failure event replayed after restore is dropped as a duplicate (dedupe state survived)",
    dlq.length === 0,
    dlq.length
      ? `it was treated as new and sent to the DLQ (${dlq[0].body.reason})`
      : "no DLQ record for the replayed event",
  );
}

main().then(
  () => finish(),
  (e) => {
    console.error(e);
    check("e2e run completed", false, String(e.message ?? e));
    finish();
  },
);

function finish() {
  evidence.finished = new Date().toISOString();
  evidence.passed = results.filter(Boolean).length;
  evidence.total = results.length;
  mkdirSync("evidence/flink", { recursive: true });
  writeFileSync(
    `evidence/flink/e2e-${RUN}.json`,
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    `\n${evidence.passed}/${evidence.total} checks passed; evidence/flink/e2e-${RUN}.json`,
  );
  process.exit(results.every(Boolean) ? 0 : 1);
}
