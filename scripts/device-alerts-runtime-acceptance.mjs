// Historical helper: real Dex login + configured membership source + owner reads.
// Fresh control-plane membership is NOT proven when configuration selects file.
// Protected credentials/signing keys remain inside configured clients, never reports.
import { readFileSync, writeFileSync } from "node:fs";
import { createVerifierFromEnv } from "@greenguard/membership-client";
import { parseEnv } from "node:util";
Object.assign(
  process.env,
  parseEnv(readFileSync(".env", "utf8")),
  parseEnv(readFileSync(".local/assistant-agent.env", "utf8")),
  parseEnv(readFileSync(".local/bff-assistant-live.env", "utf8")),
);
const report = {
  membership_source: process.env.AUTH_MEMBERSHIP_SOURCE ?? "file",
  fresh_control_plane_membership_proven: false,
  real_dex_login: false,
  device_lookup_status: null,
  owner_alert_status: null,
  association_verified: false,
  live_data_mutations: 0,
};
const original = globalThis.fetch;
globalThis.fetch = (input, init = {}) =>
  original(input, {
    ...init,
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000),
  });
let verifier;
let stage = "login";
try {
  const { login } = await import("./oidc-login.mjs");
  const { configuredAssistantAgent } =
    await import("../services/bff/dist/assistant-agent.js");
  const tokens = await login({
    email: "alice@greenguard.test",
    password: process.env.OIDC_DEV_PASSWORD,
  });
  report.real_dex_login = true;
  const authorization = `Bearer ${tokens.access_token}`;
  verifier = createVerifierFromEnv(
    (key) => process.env[key],
    (path) => readFileSync(path, "utf8"),
  );
  const serial = process.argv[2];
  if (!serial || serial.length > 200) throw new Error("serial_required");
  const origin = process.env.DEVICE_API_URL;
  if (!origin) throw new Error("device_api_unconfigured");
  const url = new URL("/v1/devices/lookup", origin);
  url.searchParams.set("serial", serial);
  stage = "placement_preflight";
  const verified = await verifier.verify(authorization);
  const placement = await fetch(
    new URL(
      "/v1/internal/placements/" + verified.tenantId,
      process.env.CONTROL_PLANE_MEMBERSHIP_URL,
    ),
    {
      headers: {
        Authorization:
          "Bearer " + process.env.CONTROL_PLANE_MEMBERSHIP_SERVICE_TOKEN,
      },
    },
  );
  report.placement_status = placement.status;
  if (placement.ok) {
    const route = await placement.json();
    const registry = JSON.parse(
      readFileSync(".local/sharding/device-service.json", "utf8"),
    );
    report.current_registry_matches_authority =
      registry.shards[route.shardId]?.incarnation === route.shardIncarnation;
    report.placement_state = route.state;
    const { default: pg } = await import("pg");
    report.physical_checks = [];
    for (const port of [55433, 57431, 57432, 57433, 57434]) {
      const forensic = process.argv.includes("--forensic");
      const dsn = new URL(
        forensic
          ? process.env.POSTGRES_ADMIN_URL
          : process.env.INVENTORY_MIGRATION_URL,
      );
      dsn.pathname = "/greenguard_inventory";
      if (
        dsn.hostname !== "127.0.0.1" ||
        !["postgres:", "postgresql:"].includes(dsn.protocol)
      )
        throw new Error("forensic_requires_loopback_postgres");
      dsn.port = String(port);
      const db = new pg.Client({
        connectionString: dsn.href,
        connectionTimeoutMillis: 2000,
        query_timeout: 2000,
      });
      try {
        await db.connect();
        await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result = await db.query(
          "SELECT shard_id,shard_incarnation,placement_epoch,state FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1",
          [verified.tenantId],
        );
        const r = result.rows[0];
        let forensicEvidence = {};
        if (forensic) {
          if (
            !/^greenguard-sharding(?:-[a-z0-9-]+)?$/.test(
              process.env.GG_SHARD_COMPOSE_PROJECT ?? "",
            )
          )
            throw new Error("forensic_physical_project_required");
          const tables = await db.query(
            "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' ORDER BY table_name",
          );
          const counts = {};
          for (const { table_name } of tables.rows) {
            if (!/^[a-z_]+$/.test(table_name))
              throw new Error("unsafe_table_identifier");
            counts[table_name] = (
              await db.query(
                'SELECT count(*)::int AS n FROM public."' +
                  table_name +
                  '" WHERE tenant_id=$1',
                [verified.tenantId],
              )
            ).rows[0].n;
          }
          const deviceCount = (
            await db.query(
              "SELECT count(*)::int AS n FROM public.devices WHERE tenant_id=$1 AND serial_number=$2 AND status<>'deleted'",
              [verified.tenantId, serial],
            )
          ).rows[0].n;
          const admin = new pg.Client({
            connectionString: dsn.href.replace(
              "/greenguard_inventory",
              "/postgres",
            ),
            connectionTimeoutMillis: 2000,
            query_timeout: 2000,
          });
          let physicalMatches = null;
          try {
            await admin.connect();
            await admin.query("BEGIN READ ONLY");
            const identity = (
              await admin.query(
                "SELECT shard_id FROM public.greenguard_shard_identity",
              )
            ).rows[0]?.shard_id;
            const system = (
              await admin.query(
                "SELECT system_identifier FROM pg_control_system()",
              )
            ).rows[0].system_identifier;
            const { createHash } = await import("node:crypto");
            const hex = createHash("sha256")
              .update(
                `${process.env.GG_SHARD_COMPOSE_PROJECT}/${identity}/${system}`,
              )
              .digest("hex");
            const incarnation = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
            physicalMatches =
              identity === route.shardId &&
              incarnation === route.shardIncarnation;
          } catch (error) {
            if (error.code !== "42P01") throw error;
          } finally {
            await admin.end();
          }
          forensicEvidence = {
            tenant_row_counts: counts,
            requested_active_device_count: deviceCount,
            physical_identity_matches_authority: physicalMatches,
          };
        }
        await db.query("ROLLBACK");
        report.physical_checks.push({
          port,
          ...forensicEvidence,
          receipt_present: !!r,
          shard_matches: !!r && r.shard_id === route.shardId,
          incarnation_matches:
            !!r && r.shard_incarnation === route.shardIncarnation,
          epoch_matches:
            !!r && String(r.placement_epoch) === route.placementEpoch,
          authority_matches:
            !!r &&
            r.shard_id === route.shardId &&
            r.shard_incarnation === route.shardIncarnation &&
            String(r.placement_epoch) === route.placementEpoch,
          state: r?.state ?? null,
        });
      } catch (e) {
        report.physical_checks.push({
          port,
          error_code: /^[0-9A-Z]{5}$/.test(e.code ?? "")
            ? e.code
            : "connection_failed",
        });
      } finally {
        await db.end();
      }
    }
  }
  if (process.argv.includes("--forensic")) {
    report.recovery_execution_allowed = false;
    report.recovery_blockers = [
      "no_authority_matching_physical_target",
      "same_shard_restore_protocol_missing",
      "cdc_history_requires_deduplication_protocol",
    ];
  }
  stage = "device_lookup";
  const response = await fetch(url, {
    headers: { Authorization: authorization },
    redirect: "error",
  });
  report.device_lookup_status = response.status;
  if (response.ok) {
    const raw = await response.text();
    if (raw.length > 8192) throw new Error("oversized_lookup");
    const device = JSON.parse(raw);
    if (
      device.serialNumber !== serial ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        device.deviceId,
      )
    )
      throw new Error("invalid_lookup");
    verifier.close();
    stage = "membership_verify";
    const principal = await verifier.verify(authorization);
    stage = "owner_delegation";
    const agent = await configuredAssistantAgent();
    if (!agent) throw new Error("delegation_unconfigured");
    const delegated = await agent.delegation.mint(
      principal,
      "workflow-alerts",
      "alerts:read",
    );
    const endpoint = new URL("/v1/alerts", "http://127.0.0.1:8097");
    endpoint.searchParams.set("deviceId", device.deviceId);
    endpoint.searchParams.set("limit", "20");
    const got = await fetch(endpoint, {
      headers: { Authorization: delegated, "X-Tenant-ID": principal.tenantId },
      redirect: "error",
    });
    report.owner_alert_status = got.status;
    if (got.ok) {
      const text = await got.text();
      if (text.length > 262144) throw new Error("oversized_owner_response");
      const body = JSON.parse(text);
      report.association_verified =
        body.association === "current_assessment_source_device";
      report.alert_count = Array.isArray(body.items) ? body.items.length : null;
      report.bounded_page =
        Array.isArray(body.items) && body.items.length <= 20;
    } else await got.body?.cancel();
  } else {
    const problem = await response.json();
    if (typeof problem.code === "string" && /^[a-z_]{1,80}$/.test(problem.code))
      report.device_lookup_code = problem.code;
  }
} catch (error) {
  report.error = "bounded_read_acceptance_failed";
  if (
    [
      "device_api_unconfigured",
      "serial_required",
      "audience is required for audience token mode",
    ].includes(error?.message)
  )
    report.error_code =
      error.message === "device_api_unconfigured"
        ? "device_api_unconfigured"
        : error.message === "serial_required"
          ? "serial_required"
          : "auth_audience_unconfigured";
  report.failed_stage = stage;
  report.error_code ??= [
    "invalid_claims",
    "auth_unavailable",
    "insufficient_role",
  ].includes(error?.code)
    ? error.code
    : "unclassified";
  report.error_status = typeof error?.status === "number" ? error.status : null;
  report.error_class = ["AuthError", "Error", "TypeError"].includes(error?.name)
    ? error.name
    : "other";
  const lookup = /^membership lookup answered ([0-9]{3})$/.exec(
    error?.message ?? "",
  );
  if (lookup) report.membership_lookup_status = Number(lookup[1]);
  if (error?.message === "malformed membership response")
    report.error_code = "malformed_membership_response";
} finally {
  verifier?.close();
  globalThis.fetch = original;
}
writeFileSync(
  "evidence/intelligence/device-alerts-local/real-owner-runtime.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
