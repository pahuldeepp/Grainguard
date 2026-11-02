// Benchmarks the optional Flink job against in-memory Go consumers doing the same derivation (ADR-0030).
// Isolated: own Compose project (gg-flink), own Kafka, topics per run. Prerequisite: `make flink-topics`.
//   node scripts/flink-bench.mjs [--only drain-small,drain-large,latency] [--devices 3000]
// Everything is measured on this machine with other containers running; read docs/FLINK_BENCHMARK.md for caveats.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkedResult, dockerGoArch } from "./flink-risk-helpers.mjs";

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
const NETWORK = "gg-flink_default";
const UI = `http://127.0.0.1:${process.env.FLINK_UI_PORT ?? "58084"}`;
const BIN_DIR = resolve("build");
const OUT_DIR = resolve("build/bench-out");
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const only = new Set(arg("only", "drain-small,drain-large,latency").split(","));
const RUN = Date.now().toString(36);
const results = {
  run: RUN,
  started: new Date().toISOString(),
  host: { note: "single Docker Desktop VM shared with other containers" },
  drains: [],
  latency: [],
};

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
const kx = (args, input) =>
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
const compose = (args, env = {}) =>
  checkedResult(
    sh("docker", [...COMPOSE, ...args], { env: { ...process.env, ...env } }),
    `owned Compose ${args[0]}`,
  );
const sum = (a) => a.reduce((x, y) => x + y, 0);
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
};

function createTopics(tag) {
  const names = {
    input: `bench.${tag}.in`,
    aggregate: `bench.${tag}.aggregate`,
    anomaly: `bench.${tag}.anomaly`,
    dlq: `bench.${tag}.dlq`,
  };
  for (const [k, n] of Object.entries(names)) {
    const r = kx([
      "kafka-topics.sh",
      "--create",
      "--topic",
      n,
      "--partitions",
      k === "dlq" ? "1" : "6",
      "--replication-factor",
      "1",
    ]);
    if (r.status !== 0)
      throw new Error(`topic ${n}: ${r.stderr.slice(0, 200)}`);
  }
  return names;
}

function endOffset(topic) {
  const r = kx(["kafka-get-offsets.sh", "--topic", topic, "--time", "-1"]);
  return sum(
    r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => Number(l.split(":")[2] ?? 0)),
  );
}

function groupLag(group) {
  const r = kx(["kafka-consumer-groups.sh", "--describe", "--group", group]);
  return sum(
    r.stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 6 && /^\d+$/.test(c[5]))
      .map((c) => Number(c[5])),
  );
}

const MIB = { KiB: 1 / 1024, MiB: 1, GiB: 1024, kB: 1 / 1024, MB: 1, GB: 1024 };
function dockerStats(prefixes) {
  const r = sh("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}",
  ]);
  let cpu = 0,
    mem = 0;
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const [name, c, m] = line.split("|");
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    cpu += parseFloat(c);
    const [used] = m.split(" / ");
    const u = used.match(/([\d.]+)([A-Za-z]+)/);
    mem += parseFloat(u[1]) * (MIB[u[2]] ?? 1);
  }
  return { cpu, mem };
}

function generate({ topic, devices, readings, salt, extra = [], spikeFile }) {
  mkdirSync(OUT_DIR, { recursive: true });
  const args = [
    "run",
    "--rm",
    "--network",
    NETWORK,
    "-v",
    `${BIN_DIR}:/bench:ro`,
    "-v",
    `${OUT_DIR}:/out`,
    "alpine:3.22",
    "/bench/stream-bench",
    "gen",
    "-brokers",
    "kafka:29092",
    "-topic",
    topic,
    "-devices",
    String(devices),
    "-salt",
    String(salt),
    ...(readings ? ["-readings", String(readings)] : []),
    ...extra,
    ...(spikeFile ? ["-spike-out", `/out/${spikeFile}`] : []),
  ];
  const r = sh("docker", args);
  if (r.status !== 0) throw new Error(`gen failed: ${r.stderr.slice(0, 300)}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

async function runningJob() {
  const t = Date.now();
  while (Date.now() - t < 180_000) {
    try {
      const jobs =
        (await (await fetch(`${UI}/jobs/overview`)).json()).jobs ?? [];
      const j = jobs.find((x) => x.state === "RUNNING");
      if (j) {
        const d = await (await fetch(`${UI}/jobs/${j.jid}`)).json();
        if (d.vertices.every((v) => v.tasks.RUNNING === v.parallelism))
          return j.jid;
      }
    } catch {
      /* not up yet */
    }
    await delay(1000);
  }
  throw new Error("Flink job did not reach RUNNING");
}

// Contenders -------------------------------------------------------------------------------------------------------
const contenders = {
  "flink-p2": { kind: "flink", parallelism: 2, taskManagers: 1 },
  "flink-p6": { kind: "flink", parallelism: 6, taskManagers: 3 },
  "go-per-record": { kind: "go", mode: "per-record" },
  "go-batched": { kind: "go", mode: "batched" },
};

async function start(name, topics, tag, extraEnv = {}) {
  const c = contenders[name];
  const group = `bench-${tag}-${name}`;
  if (c.kind === "flink") {
    compose(["stop", "flink-jobmanager", "flink-taskmanager"]);
    const env = {
      FLINK_INPUT_TOPIC: topics.input,
      FLINK_GROUP_ID: group,
      FLINK_TOPIC_AGGREGATE: topics.aggregate,
      FLINK_TOPIC_ANOMALY: topics.anomaly,
      FLINK_TOPIC_DLQ: topics.dlq,
      FLINK_PARALLELISM: String(c.parallelism),
      FLINK_CHECKPOINT_INTERVAL: "5s",
      ...extraEnv,
    };
    compose(
      [
        "up",
        "-d",
        "--force-recreate",
        "--scale",
        `flink-taskmanager=${c.taskManagers}`,
        "flink-jobmanager",
        "flink-taskmanager",
      ],
      env,
    );
    await runningJob();
    return {
      group,
      containers: ["gg-flink-flink-"],
      stop: () => compose(["stop", "flink-jobmanager", "flink-taskmanager"]),
    };
  }
  const container = `gg-bench-go-${tag}`;
  const r = sh("docker", [
    "run",
    "-d",
    "--name",
    container,
    "--network",
    NETWORK,
    "-v",
    `${BIN_DIR}:/bench:ro`,
    "alpine:3.22",
    "/bench/stream-bench",
    "baseline",
    "-brokers",
    "kafka:29092",
    "-in",
    topics.input,
    "-group",
    group,
    "-out-prefix",
    `bench.${tag}`,
    "-mode",
    c.mode,
  ]);
  if (r.status !== 0)
    throw new Error(`go baseline failed to start: ${r.stderr}`);
  return {
    group,
    containers: [container],
    stop: () => sh("docker", ["rm", "-f", container]),
  };
}

// Workload 1: drain a preloaded topic ---------------------------------------------------------------------------------
async function drain(name, { devices, readings, label, timeoutMs }) {
  const tag = `${label}-${name}-${RUN}`
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase();
  const topics = createTopics(tag);
  const load = generate({
    topic: topics.input,
    devices,
    readings,
    salt: Math.floor(Math.random() * 9000) + 1,
  });
  const total = load.events;
  const handle = await start(name, topics, tag);
  const t0 = Date.now();
  const samples = [];
  let done = null,
    last = Date.now();
  try {
    while (Date.now() - t0 < timeoutMs) {
      await delay(1500);
      const s = dockerStats(handle.containers);
      const now = Date.now();
      const agg = endOffset(topics.aggregate),
        an = endOffset(topics.anomaly);
      const lag = groupLag(handle.group);
      samples.push({ t: now - t0, dt: now - last, ...s, agg, an, lag });
      if (contenders[name].kind === "flink" && endOffset(topics.dlq) > 100)
        throw new Error(
          "Flink is rejecting the generated input (DLQ is growing): check the generator output against the contract",
        );
      last = now;
      if (agg >= load.expectedAggregates && an >= load.expectedAnomalies) {
        done = now - t0;
        break;
      }
    }
  } finally {
    handle.stop();
  }
  const active = samples.filter((s) => s.cpu > 0);
  const out = {
    contender: name,
    workload: label,
    events: total,
    expectedAggregates: load.expectedAggregates,
    expectedAnomalies: load.expectedAnomalies,
    completed: done !== null,
    seconds: (done ?? timeoutMs) / 1000,
    eventsPerSecond: done ? Math.round(total / (done / 1000)) : null,
    producedAggregates: samples.at(-1)?.agg,
    producedAnomalies: samples.at(-1)?.an,
    peakMemMiB: Math.round(Math.max(...samples.map((s) => s.mem))),
    avgCores: +(
      sum(active.map((s) => s.cpu * s.dt)) /
      sum(active.map((s) => s.dt)) /
      100
    ).toFixed(2),
    cpuSecondsPerMillionEvents: done
      ? Math.round(
          sum(samples.map((s) => (s.cpu / 100) * (s.dt / 1000))) /
            (total / 1e6),
        )
      : null,
    maxLag: Math.max(...samples.map((s) => s.lag)),
    samples: samples.length,
  };
  console.log(JSON.stringify(out));
  results.drains.push(out);
  return out;
}

// Workload 2: wall-clock event time, latency of an injected anomaly ----------------------------------------------------
async function latency(
  name,
  { label, devices, rate, duration, extraEnv = {}, drainWaitMs },
) {
  const tag = `${label}-${name}-${RUN}`
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase();
  const topics = createTopics(tag);
  const handle = await start(name, topics, tag, extraEnv);
  let load, sent, want, stats, lat;
  try {
    await delay(5000);
    const spikeFile = `spikes-${tag}.json`;
    load = generate({
      topic: topics.input,
      devices,
      salt: Math.floor(Math.random() * 9000) + 1,
      spikeFile,
      extra: [
        "-realtime",
        "-duration",
        `${duration}s`,
        "-spike-at",
        `${Math.floor(duration / 2)}s`,
        "-rate",
        String(rate),
      ],
    });
    sent = load.events;
    const spikes = JSON.parse(
      readFileSync(resolve(OUT_DIR, spikeFile), "utf8"),
    );
    want = Object.keys(spikes).length;
    const t0 = Date.now();
    lat = [];
    while (Date.now() - t0 < drainWaitMs) {
      const r = kx([
        "kafka-console-consumer.sh",
        "--topic",
        topics.anomaly,
        "--from-beginning",
        "--timeout-ms",
        "5000",
        "--property",
        "print.timestamp=true",
        "--property",
        "print.key=false",
      ]);
      lat = [];
      for (const line of r.stdout.split("\n").filter(Boolean)) {
        const [ts, ...rest] = line.split("\t");
        try {
          const body = JSON.parse(rest.join("\t"));
          const inTs = spikes[body.causation_id];
          if (inTs) lat.push(Number(ts.split(":")[1]) - inTs);
        } catch {
          /* partial line */
        }
      }
      if (lat.length >= want) break;
      await delay(3000);
    }
    stats = dockerStats(handle.containers);
  } finally {
    handle.stop();
  }
  const out = {
    contender: name,
    workload: label,
    config: extraEnv,
    sentEventsPerSecond: Math.round(sent / load.seconds),
    spikes: want,
    anomaliesSeen: lat.length,
    p50Ms: pct(lat, 0.5),
    p99Ms: pct(lat, 0.99),
    maxMs: lat.length ? Math.max(...lat) : null,
    memMiBAtEnd: Math.round(stats.mem),
  };
  console.log(JSON.stringify(out));
  results.latency.push(out);
}

async function main() {
  if (sh("docker", ["exec", KAFKA, "true"]).status !== 0)
    throw new Error("run `make flink-topics` first");
  const architecture = sh("docker", ["info", "--format", "{{.Architecture}}"]);
  if (architecture.status !== 0)
    throw new Error("Docker server architecture is unavailable");
  const goArch = dockerGoArch(architecture.stdout.trim());
  results.host.dockerArchitecture = architecture.stdout.trim();
  results.host.benchmarkGoArch = goArch;
  mkdirSync(BIN_DIR, { recursive: true });
  const build = sh(
    "go",
    ["build", "-o", resolve(BIN_DIR, "stream-bench"), "."],
    {
      cwd: "services/stream-processor/bench",
      env: {
        ...process.env,
        GOFLAGS: "-mod=readonly",
        GOPROXY: "off",
        GOOS: "linux",
        GOARCH: goArch,
        CGO_ENABLED: "0",
      },
    },
  );
  if (build.status !== 0) throw new Error(`go build failed: ${build.stderr}`);
  const devices = Number(arg("devices", "3000"));
  if (only.has("drain-small"))
    for (const c of ["flink-p2", "go-per-record", "go-batched"])
      await drain(c, {
        devices: Number(arg("small-devices", "600")),
        readings: 100,
        label: "small",
        timeoutMs: 600_000,
      });
  if (only.has("drain-large"))
    for (const c of ["flink-p2", "flink-p6", "go-batched"])
      await drain(c, {
        devices,
        readings: 100,
        label: "large",
        timeoutMs: 900_000,
      });
  if (only.has("latency")) {
    const base = { devices, rate: 5000, duration: 60 };
    await latency("go-batched", {
      ...base,
      label: "latency",
      drainWaitMs: 60_000,
    });
    await latency("flink-p2", {
      ...base,
      label: "latency-bound1s",
      extraEnv: { FLINK_MAX_OUT_OF_ORDER: "1s" },
      drainWaitMs: 90_000,
    });
    await latency("flink-p2", {
      ...base,
      label: "latency-bound2m",
      extraEnv: { FLINK_MAX_OUT_OF_ORDER: "2m" },
      drainWaitMs: 240_000,
    });
  }
  results.finished = new Date().toISOString();
  mkdirSync("evidence/flink", { recursive: true });
  writeFileSync(
    `evidence/flink/bench-${RUN}.json`,
    JSON.stringify(results, null, 2),
  );
  console.log(`\nevidence/flink/bench-${RUN}.json`);
}

main().catch((e) => {
  console.error(e);
  results.error = String(e.message ?? e);
  mkdirSync("evidence/flink", { recursive: true });
  writeFileSync(
    `evidence/flink/bench-${RUN}.json`,
    JSON.stringify(results, null, 2),
  );
  process.exit(1);
});
