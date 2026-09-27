import { createHash } from "node:crypto";
import type { Principal } from "@greenguard/tenant-auth";
import { operationHash, operations } from "./query-policy.js";

export interface RateStore {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}
export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}
export interface RateLimiter {
  check(
    principal: Principal,
    body: Record<string, unknown>,
  ): Promise<RateDecision>;
}

// Check both buckets before debiting either. Redis TIME avoids clock skew between BFF replicas.
export const TOKEN_BUCKET = `
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
local cost = tonumber(ARGV[1])
local retry = 0
local balances = {}
for i = 1, #KEYS do
  local capacity = tonumber(ARGV[2 * i])
  local refill = tonumber(ARGV[2 * i + 1])
  local state = redis.call('HMGET', KEYS[i], 'tokens', 'at')
  local tokens = tonumber(state[1]) or capacity
  local at = tonumber(state[2]) or now
  tokens = math.min(capacity, tokens + math.max(0, now - at) * refill / 1000)
  balances[i] = tokens
  if tokens < cost then retry = math.max(retry, math.ceil((cost - tokens) * 1000 / refill)) end
end
if retry > 0 then return {0, retry} end
for i = 1, #KEYS do
  local capacity = tonumber(ARGV[2 * i])
  local refill = tonumber(ARGV[2 * i + 1])
  redis.call('HSET', KEYS[i], 'tokens', balances[i] - cost, 'at', now)
  redis.call('PEXPIRE', KEYS[i], math.ceil(2 * capacity * 1000 / refill))
end
return {1, 0}
`;

const hashes = Object.fromEntries(
  Object.entries(operations).map(([name, query]) => [
    operationHash(query),
    name,
  ]),
);
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

export function operationCharge(body: Record<string, unknown>): {
  group: "read" | "mutation";
  cost: number;
} {
  const query = body.query;
  if (typeof query !== "string") throw new Error("unresolved_operation");
  const name = hashes[operationHash(query)];
  if (
    name === "startProvisioning" ||
    name === "redriveProvisioning" ||
    name === "acknowledgeAlert"
  )
    return { group: "mutation", cost: 1 };
  if (name === "deviceSearch" || name === "siteDevices" || name === "alertList")
    return { group: "read", cost: 2 };
  if (name === "readingRollups") return { group: "read", cost: 5 };
  if (name === "deviceHistory") {
    const variables = body.variables as Record<string, unknown> | undefined;
    const from = Date.parse(asText(variables?.from));
    const to = Date.parse(asText(variables?.to));
    const days =
      Number.isFinite(from) && Number.isFinite(to)
        ? Math.max(0, (to - from) / 86_400_000)
        : 31;
    return { group: "read", cost: days > 1 ? 10 : 5 };
  }
  return { group: "read", cost: 1 };
}

export function redisRateLimiter(store: RateStore): RateLimiter {
  return {
    async check(principal, body) {
      const { group, cost } = operationCharge(body);
      const tenant = principal.tenantId;
      const user = createHash("sha256").update(principal.subject).digest("hex");
      // Both keys share a Redis Cluster slot; no raw subject is stored in a key.
      const keys = [
        `rate:{${tenant}}:${group}:tenant`,
        `rate:{${tenant}}:${group}:user:${user}`,
      ];
      const budgets =
        group === "mutation"
          ? [20, 20 / 60, 5, 5 / 60]
          : [1000, 1000 / 60, 100, 10];
      if (principal.keyId) {
        const key = createHash("sha256").update(principal.keyId).digest("hex");
        keys.push(`rate:{${tenant}}:${group}:key:${key}`);
        // Per-key capacity stays below tenant capacity. An exhausted key does
        // not spend a tenant or another key's tokens because the Lua check is atomic.
        budgets.push(
          group === "mutation" ? 5 : 40,
          group === "mutation" ? 5 / 60 : 4,
        );
      }
      const reply = await store.eval(TOKEN_BUCKET, {
        keys,
        arguments: [String(cost), ...budgets.map(String)],
      });
      if (!Array.isArray(reply) || reply.length !== 2)
        throw new Error("invalid_rate_reply");
      return {
        allowed: Number(reply[0]) === 1,
        retryAfterSeconds: Math.max(1, Math.ceil(Number(reply[1]) / 1000)),
      };
    },
  };
}
