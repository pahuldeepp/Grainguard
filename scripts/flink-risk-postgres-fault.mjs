// Destructive only to the explicitly handed-over test project's PostgreSQL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

async function expectedWait(label, check, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await delay(200);
  }
  throw new Error(`${label}: timed out`);
}

export async function checkPostgresRecovery(
  ctx,
  template,
  riskProcess,
  watchedTenants,
  passed,
) {
  assert.equal(process.env.STAGE06_KAFKA_BROKER, "127.0.0.1:59112");
  assert.equal(new URL(process.env.POSTGRES_ADMIN_URL).port, "55741");
  const container = "gg-flink-risk-postgres-1";
  const inspect = spawnSync(
    "docker",
    [
      "inspect",
      container,
      "--format",
      '{{index .Config.Labels "com.docker.compose.project"}}',
    ],
    { encoding: "utf8" },
  );
  assert.equal(inspect.status, 0);
  assert.equal(
    inspect.stdout.trim(),
    "gg-flink-risk",
    "never stop a database from another project",
  );
  const docker = (action) => {
    const result = spawnSync("docker", [action, container], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `test PostgreSQL ${action} failed`);
  };
  const sentCounts = async () =>
    Promise.all(
      watchedTenants.map(
        async (tenant) =>
          (
            await ctx.query(
              "notifications",
              "SELECT count(*)::int n FROM deliveries WHERE tenant_id=$1",
              [tenant],
            )
          )[0].n,
      ),
    );
  const before = await sentCounts();
  const startedCount = async () => {
    const metrics = await fetch("http://127.0.0.1:18086/metrics", {
      signal: AbortSignal.timeout(1000),
    }).then((r) => r.text());
    return Number(
      metrics.match(/risk_anomaly_records_started_total (\d+)/)?.[1] ?? 0,
    );
  };
  const attemptsBefore = await startedCount();
  const event = structuredClone(template);
  event.event_id = randomUUID();
  const topic = "greenguard.telemetry.anomaly.v1";
  const admin = ctx.kafka.admin();
  await admin.connect();
  let metadata;
  try {
    docker("stop");
    try {
      [metadata] = await ctx.send(topic, event);
      await expectedWait(
        "risk attempts processing during PostgreSQL failure",
        async () =>
          riskProcess.exitCode !== null ||
          riskProcess.signalCode !== null ||
          (await startedCount()) > attemptsBefore,
      );
      const offsets = await admin.fetchOffsets({
        groupId: ctx.riskGroup,
        topics: [topic],
      });
      const committed =
        offsets
          .find((x) => x.topic === topic)
          .partitions.find((x) => x.partition === metadata.partition)?.offset ??
        "-1";
      assert.ok(
        BigInt(committed) <= BigInt(metadata.baseOffset),
        "failed database write must not commit the Kafka record",
      );
      const ready = await fetch("http://127.0.0.1:18086/readyz", {
        signal: AbortSignal.timeout(1000),
      }).catch(() => null);
      assert.ok(
        !ready?.ok,
        "risk must not remain ready during database failure",
      );
      // A PgBouncer query can wait for a backend before a retry is attempted.
      // Exercise explicit process recovery without claiming a wall-clock retry SLA.
      if (riskProcess.exitCode === null && riskProcess.signalCode === null)
        riskProcess.kill("SIGKILL");
      await expectedWait(
        "risk process is stopped before recovery",
        async () =>
          riskProcess.exitCode !== null || riskProcess.signalCode !== null,
      );
    } finally {
      docker("start");
    }
    await expectedWait("PostgreSQL recovers", async () => {
      await ctx.query("risk", "SELECT 1");
      return true;
    });
    // Restart the host workers with their original groups and configuration;
    // this is an explicit recovery action, not a claim of automatic process restart.
    await ctx.restartHosts();
    await ctx.until(
      "queued anomaly is durable after PostgreSQL and consumer recovery",
      async () =>
        (
          await ctx.query(
            "risk",
            "SELECT count(*)::int n FROM anomaly_decisions WHERE tenant_id=$1 AND anomaly_event_id=$2",
            [event.tenant_id, event.event_id],
          )
        )[0].n === 1,
    );
    await ctx.until(
      "queued anomaly Kafka offset commits after database recovery",
      async () => {
        const offsets = await admin.fetchOffsets({
          groupId: ctx.riskGroup,
          topics: [topic],
        });
        const committed =
          offsets
            .find((x) => x.topic === topic)
            .partitions.find((x) => x.partition === metadata.partition)
            ?.offset ?? "-1";
        return BigInt(committed) > BigInt(metadata.baseOffset);
      },
    );
    await ctx.send(topic, event);
    await ctx.until("recovered anomaly replay is deduplicated", async () => {
      const metrics = await fetch("http://127.0.0.1:18086/metrics").then((r) =>
        r.text(),
      );
      return /risk_anomaly_decisions_total\{outcome="duplicate"\} [1-9]/.test(
        metrics,
      );
    });
    assert.equal(
      (
        await ctx.query(
          "risk",
          "SELECT count(*)::int n FROM consumer_inbox WHERE tenant_id=$1 AND event_id=$2",
          [event.tenant_id, event.event_id],
        )
      )[0].n,
      1,
    );
    assert.deepEqual(
      await sentCounts(),
      before,
      "database/consumer recovery must not duplicate prior notifications",
    );
    passed(
      "PostgreSQL outage leaves offsets uncommitted; explicit worker recovery applies queued anomaly once and preserves notification deduplication",
    );
  } finally {
    await admin.disconnect();
  }
}
