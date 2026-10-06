// Live, opt-in E03/E04/E05 harness. Run alone on the local events stack.
// Like events-e2e, uses host Go processes and .env, not a transformer container.
// Requires build/cdc-transformer built from current source. E03 additionally
// builds a TEMPORARY source copy with a commit-boundary gate; shared source is
// never edited. Go, Docker CLI, migrated DBs, Kafka and Connect are prerequisites.
// Fault injection is confined to a temporary transformer binary and this group.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  broker,
  compose,
  composeArgs,
  kafka,
  rawTopic,
  connectorConfig,
  connectRequest,
  registerConnector,
} from "./events-lib.mjs";

process.loadEnvFile(".env");
const suffix = randomUUID().replaceAll("-", "");
const group = `faults-${suffix}`;
const canonical = "greenguard.inventory.device.v1";
const quarantine = "greenguard.quarantine.v1";
const raw = rawTopic("inventory");
const work = mkdtempSync(path.join(tmpdir(), "gg-faults-"));
const marker = path.join(work, "commit-gate.json");
const quarantineBlock = path.join(work, "quarantine-block");
const quarantineAttempts = path.join(work, "quarantine-attempts");
const binary = path.resolve("build/cdc-transformer");
const children = new Set();
const fixtures = [];
const connectors = [];
const records = [];
let childError;
const timeout = 120_000;

function sql(statement) {
  return compose(
    [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "greenguard_inventory",
    ],
    { input: statement },
  ).trim();
}
async function until(label, check, milliseconds = timeout) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (childError) throw childError;
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}
function child(command, args, options = {}) {
  const p = spawn(command, args, options);
  children.add(p);
  p.on("error", (error) => {
    childError = error;
  });
  p.on("exit", () => children.delete(p));
  return p;
}
async function stop(p, signal = "SIGTERM") {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const ended = new Promise((resolve) => p.once("exit", resolve));
  p.kill(signal);
  const timer = setTimeout(() => p.kill("SIGKILL"), 5000);
  await ended;
  clearTimeout(timer);
}
function start(executable, target = "", extraEnv = {}) {
  return child(executable, [], {
    stdio: "inherit",
    env: {
      ...process.env,
      HTTP_ADDR: "127.0.0.1:0",
      KAFKA_GROUP_ID: group,
      KAFKA_BROKERS: process.env.KAFKA_BROKERS || "127.0.0.1:59092",
      EVENT_SCHEMA_DIR: path.resolve("contracts/events"),
      GG_FAULT_EVENT: target,
      GG_FAULT_MARKER: marker,
      ...extraEnv,
    },
  });
}
function offsets(topic) {
  return kafka("get-offsets", ["--topic", topic, "--time", "-1"])
    .trim()
    .split("\n")
    .map((line) => {
      const [name, partition, offset] = line.split(":");
      assert.equal(name, topic);
      return { partition, offset };
    });
}
function watch(topic) {
  for (const { partition, offset } of offsets(topic)) {
    const p = child(
      "docker",
      [
        ...composeArgs,
        "exec",
        "-T",
        "kafka",
        "/opt/kafka/bin/kafka-console-consumer.sh",
        "--bootstrap-server",
        broker,
        "--topic",
        topic,
        "--partition",
        partition,
        "--offset",
        offset,
        "--property",
        "print.partition=true",
        "--property",
        "print.offset=true",
        "--consumer-property",
        "enable.auto.commit=false",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const lines = createInterface({ input: p.stdout });
    lines.on("line", (line) => {
      try {
        const match = /^Partition:(\d+)\tOffset:(\d+)\t(.*)$/.exec(line);
        assert.ok(match, "Unexpected Kafka console formatter output");
        let value;
        try {
          value = JSON.parse(match[3]);
        } catch {
          value = null;
        }
        records.push({
          topic,
          partition: Number(match[1]),
          offset: Number(match[2]),
          bytes: match[3],
          value,
          at: Date.now(),
        });
      } catch (error) {
        childError = error;
      }
    });
    p.on("exit", () => lines.close());
  }
}
function event() {
  const device = randomUUID();
  return {
    event_id: randomUUID(),
    event_type: "device.registered",
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    tenant_id: randomUUID(),
    aggregate_type: "device",
    aggregate_id: device,
    aggregate_version: "1",
    correlation_id: randomUUID(),
    causation_id: randomUUID(),
    traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
    payload: {
      device_id: device,
      binding_version: "1",
      status: "active",
      serial_number: `FAULT-${device}`,
      site_id: randomUUID(),
      bin_id: null,
    },
  };
}
function insert(e) {
  fixtures.push(e);
  sql(`BEGIN; SET LOCAL session_replication_role = replica; SET LOCAL ROLE inventory_app; SELECT set_config('app.tenant_id','${e.tenant_id}',true);
    INSERT INTO outbox_events (event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,correlation_id,causation_id,traceparent,payload)
    VALUES ('${e.event_id}','${e.tenant_id}','device','${e.aggregate_id}',1,'device.registered',1,'${e.occurred_at}','${e.correlation_id}','${e.causation_id}','${e.traceparent}','${JSON.stringify(e.payload)}'); COMMIT;`);
}
function publish(values) {
  compose(
    [
      "exec",
      "-T",
      "kafka",
      "/opt/kafka/bin/kafka-console-producer.sh",
      "--bootstrap-server",
      broker,
      "--topic",
      raw,
      "--producer-property",
      "acks=all",
    ],
    { input: values.join("\n") + "\n" },
  );
}
const envelope = (e) =>
  JSON.stringify({ op: "c", source: { table: "outbox_events" }, after: e });
const copies = (e) =>
  records.filter(
    (r) => r.topic === canonical && r.value?.event_id === e.event_id,
  );
function identical(events) {
  for (const e of events) {
    const observed = records.filter(
      (r) => r.topic === canonical && r.value?.tenant_id === e.tenant_id,
    );
    assert.ok(observed.length, `Missing event ${e.event_id}`);
    for (const r of observed) {
      assert.equal(r.value.event_id, e.event_id, "Regenerated event_id");
      assert.equal(r.bytes, observed[0].bytes, "Non-identical duplicate");
    }
  }
}
function committed() {
  const rows = kafka("consumer-groups", ["--group", group, "--describe"])
    .split("\n")
    .map((line) => line.trim().split(/\s+/));
  const row = rows.find((r) => r[0] === group && r[1] === raw && r[2] === "0");
  return row && /^\d+$/.test(row[3]) ? Number(row[3]) : -1;
}
function copyTransformer(source) {
  cpSync("services/cdc-transformer", source, { recursive: true });
  const moduleFile = path.join(source, "go.mod");
  let moduleText = readFileSync(moduleFile, "utf8");
  for (const name of ["kafka-transport", "go-common"]) {
    moduleText = moduleText.replaceAll(
      `../../packages/${name}`,
      path.resolve("packages", name),
    );
  }
  writeFileSync(moduleFile, moduleText);
}
function gatedBinary() {
  const source = path.join(work, "source");
  copyTransformer(source);
  const file = path.join(source, "kafka.go");
  const original = readFileSync(file, "utf8");
  const needle = "return k.client.CommitRecords(ctx, record)";
  assert.equal(
    original.split(needle).length,
    2,
    "Commit seam changed; review the gate before running",
  );
  writeFileSync(
    file,
    original.replace(
      needle,
      "if err := faultGate(ctx, record); err != nil { return err }; " + needle,
    ),
  );
  writeFileSync(
    path.join(source, "fault_gate.go"),
    `package main
import ("context"; "encoding/json"; "os"; "github.com/twmb/franz-go/pkg/kgo")
func faultGate(ctx context.Context, r *kgo.Record) error {
 var v struct { Op string \`json:"op"\`; After struct { ID string \`json:"event_id"\` } \`json:"after"\` }
 if json.Unmarshal(r.Value, &v) != nil || v.Op != "r" || v.After.ID != os.Getenv("GG_FAULT_EVENT") { return nil }
 b, err := json.Marshal(map[string]any{"topic":r.Topic,"partition":r.Partition,"offset":r.Offset}); if err != nil { return err }
 if err = os.WriteFile(os.Getenv("GG_FAULT_MARKER"), b, 0600); err != nil { return err }
 <-ctx.Done(); return ctx.Err()
}
`,
  );
  const output = path.join(work, "cdc-transformer-gated");
  const result = spawnSync("go", ["build", "-o", output, "."], {
    cwd: source,
    stdio: "inherit",
  });
  assert.equal(result.status, 0, "Temporary gated transformer build failed");
  return output;
}
function quarantineFaultBinary() {
  const source = path.join(work, "quarantine-source");
  copyTransformer(source);
  const file = path.join(source, "kafka.go");
  const original = readFileSync(file, "utf8");
  assert.match(
    original,
    /transport\.SharedOps/,
    "Quarantine adapter seam changed",
  );
  assert.doesNotMatch(
    original,
    /func \(k \*Kafka\) PublishQuarantine/,
    "Quarantine override already exists",
  );
  writeFileSync(
    file,
    `${original}\nfunc (k *Kafka) PublishQuarantine(ctx context.Context, record Record) error {
 if err := quarantineFault(record); err != nil { return err }
 return k.SharedOps.PublishQuarantine(ctx, record)
}\n`,
  );
  writeFileSync(
    path.join(source, "quarantine_fault.go"),
    `package main
import ("errors"; "os")
func quarantineFault(record Record) error {
 if string(record.Key) != os.Getenv("GG_FAULT_QUARANTINE_KEY") { return nil }
 if _, err := os.Stat(os.Getenv("GG_FAULT_BLOCK_FILE")); os.IsNotExist(err) { return nil } else if err != nil { return err }
 file, err := os.OpenFile(os.Getenv("GG_FAULT_ATTEMPTS"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600); if err != nil { return err }
 if _, err = file.WriteString("attempt\\n"); err != nil { file.Close(); return err }
 if err = file.Close(); err != nil { return err }
 return errors.New("injected quarantine publish failure")
}
`,
  );
  const output = path.join(work, "cdc-transformer-quarantine-fault");
  const result = spawnSync("go", ["build", "-o", output, "."], {
    cwd: source,
    stdio: "inherit",
  });
  assert.equal(
    result.status,
    0,
    "Temporary quarantine-fault transformer build failed",
  );
  return output;
}
async function snapshot(e) {
  const id = randomUUID().replaceAll("-", "");
  const spec = { name: `faults-${id}`, slot: `gg_fault_${id}` };
  connectors.push(spec);
  const prefix = `fault_${id}`;
  const config = {
    ...connectorConfig("inventory"),
    "slot.name": spec.slot,
    "topic.prefix": prefix,
    "transforms.rawTopic.regex": `^${prefix}\\.public\\.outbox_events$`,
    "snapshot.select.statement.overrides": "public.outbox_events",
    "snapshot.select.statement.overrides.public.outbox_events": `SELECT * FROM public.outbox_events WHERE tenant_id='${e.tenant_id}'`,
    "heartbeat.interval.ms": "0",
    "message.prefix.exclude.list": ".*",
  };
  delete config["heartbeat.action.query"];
  delete config["message.prefix.include.list"];
  await registerConnector(spec.name, config);
}
async function e03() {
  const events = [event(), event()];
  const gated = gatedBinary();
  let transformer = start(gated, events[0].event_id);
  events.forEach(insert);
  await until("baseline canonical delivery", () =>
    events.every((e) => copies(e).length),
  );
  await snapshot(events[0]);
  await until("post-ack pre-commit gate", () => existsSync(marker));
  const coordinate = JSON.parse(readFileSync(marker, "utf8"));
  await until(
    "snapshot canonical ack visible",
    () => copies(events[0]).length >= 2,
  );
  assert.equal(coordinate.topic, raw);
  assert.equal(coordinate.partition, 0);
  assert.ok(
    committed() <= coordinate.offset,
    "Raw offset advanced through gate",
  );
  assert.equal(
    transformer.exitCode,
    null,
    "Transformer exited before crash injection",
  );
  assert.equal(transformer.signalCode, null);
  await stop(transformer, "SIGKILL");
  assert.equal(
    transformer.signalCode,
    "SIGKILL",
    "Crash boundary was not exercised",
  );
  assert.ok(committed() <= coordinate.offset, "Crash committed gated offset");
  const before = copies(events[0]).length;
  transformer = start(binary);
  await until(
    "crashed snapshot redelivered",
    () => copies(events[0]).length > before,
  );
  await snapshot(events[1]);
  await until(
    "second tenant snapshot repeated",
    () => copies(events[1]).length >= 2,
  );
  await until(
    "source frontier passes crashed record",
    () => committed() > coordinate.offset,
  );
  identical(events);
  console.log(
    "PASS E03: snapshot repeats, SIGKILL after ack/before commit, restart preserves every ID and duplicate bytes",
  );
  return transformer;
}
async function e04(transformer) {
  await stop(transformer);
  const good = event();
  const poison = `{malformed:${randomUUID()}:${randomUUID()}`;
  publish([poison, envelope(good)]);
  await until("poison raw coordinates", () =>
    records.some((r) => r.topic === raw && r.bytes === poison),
  );
  const source = records.find((r) => r.topic === raw && r.bytes === poison);
  const faultKey = `${raw}:${source.partition}:${source.offset}`;
  const faulty = quarantineFaultBinary();
  writeFileSync(quarantineBlock, "blocked\n");
  transformer = start(faulty, "", {
    GG_FAULT_QUARANTINE_KEY: faultKey,
    GG_FAULT_BLOCK_FILE: quarantineBlock,
    GG_FAULT_ATTEMPTS: quarantineAttempts,
    HTTP_ADDR: "127.0.0.1:18091",
  });
  await until(
    "two failed quarantine attempts",
    () =>
      existsSync(quarantineAttempts) &&
      readFileSync(quarantineAttempts, "utf8").trim().split("\n").length >= 2,
  );
  assert.ok(
    committed() <= source.offset,
    "Poison offset advanced while quarantine publish failed",
  );
  assert.equal(
    copies(good).length,
    0,
    "Later valid event passed blocked poison",
  );
  const readiness = await fetch("http://127.0.0.1:18091/readyz", {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(
    readiness.status,
    503,
    "Quarantine failure must degrade readiness",
  );
  console.log(
    "PASS E04 quarantine publish failure: retries, degraded readiness, no offset advance or later delivery",
  );
  rmSync(quarantineBlock);
  await until(
    "quarantine and subsequent valid event",
    () =>
      copies(good).length &&
      records.some(
        (r) =>
          r.topic === quarantine &&
          r.value?.raw_base64 === Buffer.from(poison).toString("base64"),
      ),
  );
  const q = records.find(
    (r) =>
      r.topic === quarantine &&
      r.value?.raw_base64 === Buffer.from(poison).toString("base64"),
  ).value;
  assert.equal(q.source_topic, raw);
  assert.equal(q.source_partition, source.partition);
  assert.equal(q.source_offset, source.offset);
  assert.equal(q.truncated, false);
  assert.equal(q.reason, "bad_envelope");
  await until(
    "poison offset committed after quarantine",
    () => committed() > source.offset,
  );
  identical([good]);
  console.log(
    "PASS E04 healthy quarantine: original bytes/coordinates and later valid delivery",
  );
  return transformer;
}
async function e05(transformer) {
  // Current config: PollRecords(ctx,1), ProducerLinger(0), ProduceSync,
  // RecordDeliveryTimeout(15s). There is no batch-size threshold to fill.
  const source = readFileSync("packages/kafka-transport/transport.go", "utf8");
  assert.match(source, /ProducerLinger\(0\)/);
  assert.match(source, /PollRecords\(ctx, 1\)/);
  assert.match(source, /RecordDeliveryTimeout\(15\s*\*\s*time.Second\)/);
  const probe = event();
  const rawBytes = envelope(probe);
  const began = Date.now();
  publish([rawBytes]);
  await until(
    "idle singleton delivered",
    () =>
      copies(probe).length &&
      records.some((r) => r.topic === raw && r.bytes === rawBytes),
  );
  // Conservative end-to-end bound includes producer CLI startup and observer
  // scheduling; never subtract the independently scheduled raw observer clock.
  assert.ok(
    copies(probe)[0].at - began <= 15_000,
    "Singleton delivery exceeded 15s",
  );
  await stop(transformer, "SIGKILL");
  const pending = event();
  publish([envelope(pending)]);
  start(binary);
  await until(
    "pending singleton survives restart",
    () => copies(pending).length,
  );
  identical([probe, pending]);
  console.log(
    "PASS E05: idle singleton delivery within 15s, pending singleton survives restart; no batching in current producer",
  );
}
async function cleanup() {
  const errors = [];
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  await Promise.all([...children].map((p) => stop(p)));
  for (const spec of connectors)
    await attempt(async () => {
      await connectRequest(`/connectors/${spec.name}`, "DELETE").catch(
        (error) => {
          if (error.status !== 404) throw error;
        },
      );
      const end = Date.now() + 30_000;
      while (
        sql(
          `SELECT active FROM pg_replication_slots WHERE slot_name='${spec.slot}';`,
        ) === "t"
      ) {
        assert.ok(Date.now() < end, `Slot ${spec.slot} stayed active`);
        await delay(1000);
      }
      sql(
        `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name='${spec.slot}';`,
      );
    });
  for (const e of fixtures)
    await attempt(() =>
      sql(
        `DELETE FROM outbox_events WHERE tenant_id='${e.tenant_id}' AND event_id='${e.event_id}';`,
      ),
    );
  await attempt(() => kafka("consumer-groups", ["--delete", "--group", group]));
  rmSync(work, { recursive: true, force: true });
  if (errors.length)
    throw new AggregateError(errors, "Fault harness cleanup failed");
}
let primary;
try {
  assert.ok(
    existsSync(binary),
    "Build current source to build/cdc-transformer before running",
  );
  // Another transformer could hide a failed restart by supplying its own copy.
  const liveMembers = kafka("consumer-groups", [
    "--group",
    "greenguard-cdc-transformer-v1",
    "--describe",
    "--members",
  ]);
  assert.ok(
    !liveMembers
      .split("\n")
      .some((line) => line.trim().startsWith("greenguard-cdc-transformer-v1 ")),
    "Stop the normal transformer before this acceptance run; also stop any custom transformer groups",
  );
  // Exclude historical data for this unique test group, without moving live groups.
  for (const topic of [raw, rawTopic("telemetry")])
    kafka("consumer-groups", [
      "--group",
      group,
      "--reset-offsets",
      "--topic",
      topic,
      "--to-latest",
      "--execute",
    ]);
  for (const topic of [raw, canonical, quarantine]) watch(topic);
  const transformer = await e03();
  const recovered = await e04(transformer);
  await e05(recovered);
} catch (error) {
  primary = error;
}
try {
  await cleanup();
} catch (error) {
  if (!primary) primary = error;
  else console.error(error);
}
if (primary) throw primary;
