import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  broker,
  compose,
  composeArgs,
  databases,
  kafka,
  rawTopic,
  connectorConfig,
  connectorName,
  connectRequest,
  registerConnector,
  waitRunning,
} from "./events-lib.mjs";

// Only synthetic outbox rows: this tests CDC, not domain commands or canonical schemas.
const fixtures = [];
const temporary = [];
function sql(database, statement) {
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
      `greenguard_${database}`,
    ],
    { input: statement },
  ).trim();
}
function row(database) {
  const fixture = {
    database,
    tenant: randomUUID(),
    event: randomUUID(),
    aggregate: randomUUID(),
  };
  fixtures.push(fixture);
  return fixture;
}
function insert(fixture, commit = true) {
  const { database, tenant, event, aggregate } = fixture;
  sql(
    database,
    `BEGIN;
    SET LOCAL session_replication_role = replica;
    SET LOCAL ROLE ${database}_app;
    SELECT set_config('app.tenant_id', '${tenant}', true);
    INSERT INTO outbox_events
      (event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,
       schema_version,occurred_at,correlation_id,causation_id,traceparent,payload)
    VALUES ('${event}','${tenant}','device','${aggregate}',1,'device.registered',
      1,clock_timestamp(),'${randomUUID()}','${randomUUID()}',
      '00-00000000000000000000000000000001-0000000000000001-01','{}');
    ${commit ? "COMMIT" : "ROLLBACK"};`,
  );
  fixture.committedAt = Date.now();
}
function offset(database) {
  const topic = rawTopic(database);
  const result = kafka("get-offsets", [
    "--topic",
    topic,
    "--time",
    "-1",
  ]).trim();
  const match = result.match(
    new RegExp(`^${topic.replaceAll(".", "\\.")}:0:(\\d+)$`),
  );
  assert.ok(match, `Expected exactly one partition for ${topic}`);
  return match[1];
}

// An explicit partition/offset avoids group rebalances and replaying historic runs.
// Observe at least 30s for negative assertions, even after all positives arrive.
function capture(database, startOffset) {
  const started = Date.now();
  const records = [];
  const child = spawn(
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
      rawTopic(database),
      "--partition",
      "0",
      "--offset",
      startOffset,
      "--timeout-ms",
      "35000",
      "--consumer-property",
      "enable.auto.commit=false",
      "--consumer-property",
      "allow.auto.create.topics=false",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  let parseError;
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      records.push({ value: JSON.parse(line), receivedAt: Date.now() });
    } catch {
      parseError = new Error(`Invalid raw JSON on ${rawTopic(database)}`);
    }
  });
  // Inventory checkpoints arrive every 30s, so the idle timeout may never fire;
  // the fixed observation window then ends the watcher, which is not a failure.
  let windowClosed = false;
  const timer = setTimeout(() => {
    windowClosed = true;
    child.kill("SIGTERM");
  }, 60_000);
  const result = new Promise((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      lines.close();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      lines.close();
      if (parseError) return reject(parseError);
      const expired =
        windowClosed ||
        ([0, 1].includes(code) && stderr.includes("TimeoutException"));
      if (!expired || Date.now() - started < 30_000)
        return reject(
          new Error(
            `Kafka observation failed for ${database} (exit ${code}): ${stderr}`,
          ),
        );
      resolve(records);
    });
  });
  // Attach immediately: provisioning failure must not leave unhandled rejections.
  return result.then(
    (records) => ({ records }),
    (error) => ({ error }),
  );
}
async function observed(watcher) {
  const result = await watcher;
  if (result.error) throw result.error;
  return result.records;
}
function delivered(records, fixture, op, since = fixture.committedAt) {
  const matches = records.filter(
    ({ value }) => value?.after?.event_id === fixture.event && value.op === op,
  );
  assert.ok(
    matches.length > 0,
    `${fixture.database}: missing ${op} event ${fixture.event}`,
  );
  assert.ok(
    matches.some(({ receivedAt }) => receivedAt - since <= 30_000),
    `${fixture.database}: delivery exceeded 30s`,
  );
  for (const { value } of matches) {
    assert.equal(value.after.tenant_id, fixture.tenant);
    assert.equal(value.source.table, "outbox_events");
    assert.equal(value.source.db, `greenguard_${fixture.database}`);
  }
}

function checkAccess(database, rows) {
  const result = sql(
    database,
    `SET ROLE cdc_reader;
    SELECT count(*) FROM public.outbox_events WHERE event_id IN ('${rows.map((r) => r.event).join("','")}');`,
  );
  assert.equal(
    result,
    String(rows.length),
    `${database}: CDC must read both tenants without tenant context`,
  );
  assert.equal(
    sql(
      database,
      `SELECT count(*) FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname <> 'outbox_events'
    AND has_table_privilege('cdc_reader',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');`,
    ),
    "0",
  );
  assert.equal(
    sql(
      database,
      `SELECT rolcanlogin AND rolreplication AND NOT
    (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit)
    FROM pg_roles WHERE rolname='cdc_reader';`,
    ),
    "t",
  );
  assert.equal(
    sql(
      database,
      `SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='outbox_events'::regclass;`,
    ),
    "t",
  );
}
async function removeSnapshot({ database, name, slot }) {
  try {
    await connectRequest(`/connectors/${name}`, "DELETE");
  } catch (error) {
    // A connector whose registration failed was never created; still drop its slot.
    if (error.status !== 404) throw error;
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const active = sql(
      database,
      `SELECT active FROM pg_replication_slots WHERE slot_name='${slot}';`,
    );
    if (active !== "t") {
      sql(
        database,
        `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name='${slot}';`,
      );
      return;
    }
    await delay(1000);
  }
  throw new Error(`Temporary slot ${slot} remained active`);
}
async function snapshots() {
  for (const database of databases) {
    const start = offset(database);
    const rows = [row(database), row(database)];
    rows.forEach((fixture) => insert(fixture));
    checkAccess(database, rows);
    const suffix = randomUUID().replaceAll("-", "");
    const spec = {
      database,
      name: `snapshot-${database}-${suffix}`,
      slot: `gg_test_${suffix}`,
    };
    temporary.push(spec);
    // A second connector with the live one's topic.prefix collides on Debezium's
    // JMX MBean name and fails, so the temporary connector gets its own prefix
    // and the router maps it onto the same raw topic.
    const base = connectorConfig(database);
    const prefix = `snap_${suffix}`;
    const config = {
      ...base,
      "slot.name": spec.slot,
      "topic.prefix": prefix,
      "transforms.rawTopic.regex": `^${prefix}\\.public\\.outbox_events$`,
      // No heartbeat topic exists for this throwaway prefix; a heartbeat would block
      // the task, fail its graceful stop and leave the replication slot active.
      "heartbeat.interval.ms": "0",
      // The slot also decodes the live connector's checkpoint messages, which
      // would target an unprovisioned "<prefix>.message" topic.
      "message.prefix.exclude.list": ".*",
    };
    delete config["heartbeat.action.query"];
    delete config["message.prefix.include.list"];
    // Snapshot rows predate this fresh connector AND its fresh replication slot.
    const watcher = capture(database, start);
    const began = Date.now();
    await registerConnector(spec.name, config);
    const records = await observed(watcher);
    rows.forEach((fixture) => delivered(records, fixture, "r", began));
    await removeSnapshot(spec);
    temporary.pop();
    console.log(
      `R1 ${database}: both tenants delivered by initial snapshot under forced RLS`,
    );
  }
}
async function committedAndRollback() {
  const runs = databases.map((database) => {
    const start = offset(database);
    const committed = row(database);
    const rolledBack = row(database);
    insert(committed);
    insert(rolledBack, false);
    return {
      database,
      committed,
      rolledBack,
      watcher: capture(database, start),
    };
  });
  for (const run of runs) {
    const records = await observed(run.watcher);
    delivered(records, run.committed, "c");
    assert.ok(
      records.every(
        ({ value }) => value?.after?.event_id !== run.rolledBack.event,
      ),
      "Rolled-back event leaked",
    );
    console.log(
      `E01 ${run.database}: commit delivered within 30s; rollback absent throughout observation`,
    );
  }
}
async function outage() {
  const runs = databases.map((database) => ({
    database,
    start: offset(database),
    rows: [row(database), row(database), row(database)],
  }));
  compose(["stop", "connect"]);
  try {
    for (const run of runs) run.rows.forEach((fixture) => insert(fixture));
  } finally {
    compose(["up", "-d", "--wait", "connect"]);
  }
  const restarted = Date.now();
  for (const run of runs) run.watcher = capture(run.database, run.start);
  for (const database of databases) await waitRunning(connectorName(database));
  for (const run of runs) {
    const records = await observed(run.watcher);
    run.rows.forEach((fixture) => delivered(records, fixture, "c", restarted));
    console.log(
      `E02 ${run.database}: all ${run.rows.length} outage commits delivered at least once`,
    );
  }
}
async function cleanup() {
  const failures = [];
  for (const spec of temporary) {
    try {
      await removeSnapshot(spec);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const fixture of fixtures) {
    try {
      sql(
        fixture.database,
        `DELETE FROM outbox_events WHERE tenant_id='${fixture.tenant}' AND event_id='${fixture.event}';`,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Smoke cleanup failed; inspect temporary connectors/slots",
    );
}
let primary;
try {
  for (const database of databases) await waitRunning(connectorName(database));
  await snapshots();
  await committedAndRollback();
  await outage();
  console.log(
    "PASS: raw CDC E01, R1 snapshot and E02 Connect outage (full E03–E05 deferred)",
  );
} catch (error) {
  primary = error;
}
try {
  await cleanup();
} catch (error) {
  // Never let a cleanup failure hide the check that actually failed.
  if (!primary) throw error;
  console.error(error);
}
if (primary) throw primary;
