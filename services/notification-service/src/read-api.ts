import { ownerDatabases } from "@greenguard/membership-client/owner-db";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  AuthError,
  requireRole,
  type Principal,
} from "@greenguard/tenant-auth";
import { withTenant } from "./tenant.js";
import { createHmac } from "node:crypto";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_INTENT_IDS = 100;
const MAX_ATTEMPTS = 20;
type Verify = (authorization: string | undefined) => Promise<Principal>;
type Pair = { intentId: string; deliveryGeneration: number };

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 16_384) throw new Error("body_too_large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

function parsePairs(value: unknown): Pair[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_INTENT_IDS
  )
    throw new Error("invalid_lookup_pairs");
  const pairs = value.map((item) => {
    if (!item || typeof item !== "object")
      throw new Error("invalid_lookup_pairs");
    const row = item as Record<string, unknown>;
    if (
      typeof row.intentId !== "string" ||
      !UUID.test(row.intentId) ||
      !Number.isSafeInteger(row.deliveryGeneration) ||
      (row.deliveryGeneration as number) < 0
    )
      throw new Error("invalid_lookup_pairs");
    return {
      intentId: row.intentId,
      deliveryGeneration: row.deliveryGeneration as number,
    };
  });
  const unique = new Set(
    pairs.map((pair) => `${pair.intentId}:${pair.deliveryGeneration}`),
  );
  if (unique.size !== pairs.length) throw new Error("duplicate_lookup_pair");
  return pairs;
}

function state(value: string): string {
  switch (value) {
    case "received":
      return "queued";
    case "in_progress":
      return "sending";
    case "retry":
      return "retrying";
    case "sent":
      return "accepted";
    case "failed":
      return "rejected";
    case "suppressed":
      return "suppressed";
    case "dead":
      return "dead";
    case "unknown":
      return "unknown";
    default:
      return "unknown";
  }
}

function reason(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.toLowerCase();
  if (normalized.includes("preference")) return "tenant_preference";
  if (normalized.includes("hold exhausted")) return "retries_exhausted";
  if (normalized.includes("timeout")) return "provider_timeout";
  if (normalized.includes("unavailable")) return "provider_unavailable";
  if (normalized.includes("reject")) return "recipient_rejected";
  if (normalized.includes("auth") || normalized.includes("config"))
    return "provider_auth_or_config";
  return "provider_error_unspecified";
}

/** Owner-only bounded lookup. It never returns provider references, recipient data, raw detail or correlation IDs. */
export function notificationReadHandler(
  pool: Pool,
  verify: Verify,
  auditKey: string,
) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://notification-service.local");
    if (url.pathname !== "/internal/v1/deliveries/lookup") return false;
    if (req.method !== "POST") {
      send(res, 405, { error: "method_not_allowed" });
      return true;
    }
    try {
      const principal = await verify(req.headers.authorization);
      requireRole(principal, "operator", "admin");
      if (auditKey.length < 32) throw new Error("audit_not_configured");
      const auditId = createHmac("sha256", auditKey)
        .update(
          `notification-read-v1\0${principal.tenantId}\0${principal.subject}`,
        )
        .digest("hex")
        .slice(0, 24);
      const body = (await readJson(req)) as Record<string, unknown>;
      const pairs = parsePairs(body?.pairs);
      const result = await withTenant(
        pool,
        principal.tenantId,
        async (client) => {
          await client.query("SET LOCAL statement_timeout = '3000ms'");
          const ids = pairs.map((pair) => pair.intentId);
          const generations = pairs.map((pair) => pair.deliveryGeneration);
          const { rows } = await client.query<{
            intent_id: string;
            delivery_generation: number;
            channel: string;
            severity: string;
            status: string;
            attempts: number;
            reconciles: number;
            last_error: string | null;
            created_at: Date;
            updated_at: Date;
            terminal_at: Date | null;
            attempt_no: number | null;
            kind: string | null;
            outcome: string | null;
            recorded_at: Date | null;
            attempt_total: number | null;
            attempt_first_at: Date | null;
          }>(
            `WITH requested AS (
             SELECT * FROM unnest($2::uuid[], $3::integer[]) AS p(intent_id, delivery_generation)
           ), attempts AS (
             SELECT a.intent_id, a.delivery_generation, a.attempt_no, a.kind, a.outcome, a.recorded_at,
                    row_number() OVER (PARTITION BY a.intent_id, a.delivery_generation ORDER BY a.attempt_no DESC) AS n,
                    count(*) OVER (PARTITION BY a.intent_id, a.delivery_generation) AS total,
                    min(a.recorded_at) OVER (PARTITION BY a.intent_id, a.delivery_generation) AS first_at
               FROM delivery_attempts a JOIN requested r
                 ON r.intent_id = a.intent_id AND r.delivery_generation = a.delivery_generation
               JOIN deliveries warning_delivery
                 ON warning_delivery.tenant_id = a.tenant_id
                AND warning_delivery.intent_id = a.intent_id
                AND warning_delivery.delivery_generation = a.delivery_generation
                AND warning_delivery.severity = 'warning'
              WHERE a.tenant_id = $1
           )
           SELECT d.intent_id::text, d.delivery_generation, d.channel, d.severity, d.status, d.attempts, d.reconciles,
                  d.last_error, d.created_at, d.updated_at, d.terminal_at,
                  a.attempt_no, a.kind, a.outcome, a.recorded_at, a.total::integer AS attempt_total,
                  a.first_at AS attempt_first_at
             FROM requested r JOIN deliveries d ON d.tenant_id = $1 AND d.intent_id = r.intent_id
                  AND d.delivery_generation = r.delivery_generation
             LEFT JOIN attempts a ON a.intent_id = d.intent_id AND a.delivery_generation = d.delivery_generation AND a.n <= $4
            WHERE d.tenant_id = $1 AND d.severity = 'warning'
            ORDER BY d.intent_id, a.attempt_no DESC`,
            [principal.tenantId, ids, generations, MAX_ATTEMPTS],
          );
          const grouped = new Map<string, Record<string, unknown>>();
          for (const row of rows) {
            const key = `${row.intent_id}:${row.delivery_generation}`;
            let item = grouped.get(key);
            if (!item) {
              item = {
                intentId: row.intent_id,
                deliveryGeneration: row.delivery_generation,
                state: state(row.status),
                reasonCode: reason(row.last_error),
                firstAttemptAt: row.attempt_first_at?.toISOString() ?? null,
                lastAttemptAt: row.updated_at.toISOString(),
                resolvedAt: row.terminal_at?.toISOString() ?? null,
                providerAttempts: row.attempts + row.reconciles,
                dispatchAttempts: null,
                events: [] as unknown[],
                attemptsTruncated: (row.attempt_total ?? 0) > MAX_ATTEMPTS,
              };
              grouped.set(key, item);
            }
            if (row.attempt_no !== null && Array.isArray(item.events)) {
              (item.events as unknown[]).push({
                kind: row.kind,
                outcome: state(row.outcome ?? "unknown"),
                recordedAt: row.recorded_at?.toISOString() ?? null,
              });
            }
          }
          return [...grouped.values()];
        },
      );
      send(res, 200, { items: result });
      console.info(
        JSON.stringify({
          event: "notification_history_read",
          audit_id: auditId,
          result_count: result.length,
        }),
      );
    } catch (error) {
      if (error instanceof AuthError)
        send(res, error.status, { error: error.code });
      else if (
        error instanceof Error &&
        [
          "invalid_lookup_pairs",
          "duplicate_lookup_pair",
          "invalid_json",
          "body_too_large",
        ].includes(error.message)
      )
        send(res, error.message === "body_too_large" ? 413 : 400, {
          error: error.message,
        });
      else send(res, 503, { error: "owner_read_unavailable" });
    }
    return true;
  };
}

export async function notificationReadReady(
  pool: Pool,
  auditKey: string,
): Promise<boolean> {
  if (auditKey.length < 32) return false;
  const checks = await Promise.all(
    ownerDatabases(pool).map((owner) => notificationPoolReady(owner)),
  );
  return checks.every(Boolean);
}

async function notificationPoolReady(pool: Pool): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ ready: boolean }>(
      `SELECT current_user = 'notifications_app'
          AND NOT role.rolsuper AND NOT role.rolbypassrls
          AND NOT EXISTS (SELECT 1 FROM pg_roles elevated
                           WHERE elevated.rolbypassrls AND pg_has_role(current_user, elevated.oid, 'USAGE'))
          AND has_table_privilege(current_user, 'deliveries', 'SELECT')
          AND has_table_privilege(current_user, 'delivery_attempts', 'SELECT')
          AND NOT has_table_privilege(current_user, 'deliveries', 'DELETE')
          AND NOT has_table_privilege(current_user, 'delivery_attempts', 'DELETE')
          AND (SELECT count(*) = 2 FROM pg_class c
                WHERE c.relnamespace = current_schema()::regnamespace
                  AND c.relname IN ('deliveries', 'delivery_attempts')
                  AND c.relrowsecurity AND c.relforcerowsecurity)
          AND (SELECT count(*) = 2 FROM pg_policies p
                WHERE p.schemaname = current_schema()
                  AND p.tablename IN ('deliveries', 'delivery_attempts')
                  AND p.policyname = 'tenant_isolation'
                  AND p.qual LIKE '%app.tenant_id%') AS ready
         FROM pg_roles role WHERE role.rolname = current_user`,
    );
    return rows[0]?.ready === true;
  } catch {
    return false;
  }
}
