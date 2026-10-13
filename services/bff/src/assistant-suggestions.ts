import { createHash } from "node:crypto";

/** A suggestion is content owned by the application, never by Redis or a model. */
export interface AssistantSuggestion {
  id: string;
  label: string;
}

export const ASSISTANT_SUGGESTIONS: readonly AssistantSuggestion[] = [
  {
    id: "grain_moisture",
    label: "What do my documents say about grain moisture?",
  },
  {
    id: "storage_checks",
    label: "Summarize the storage checks for this site.",
  },
  { id: "mold_risk", label: "Which procedure should I follow for mold risk?" },
  { id: "grain_drying", label: "What are the recommended grain drying steps?" },
  {
    id: "document_summary",
    label: "Summarize the key points in my documents.",
  },
] as const;

const CATALOG_BY_ID = new Map(
  ASSISTANT_SUGGESTIONS.map((suggestion) => [suggestion.id, suggestion]),
);
const DEFAULT_LIMIT = 4;
const MAX_LIMIT = ASSISTANT_SUGGESTIONS.length;
const KEY_TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_RETAINED_MEMBERS = 100;

/** Minimal interface implemented by the BFF's Redis client. */
export interface AssistantSuggestionRedis {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

export interface AssistantSuggestionStore {
  list(tenantId: string, limit?: number): Promise<AssistantSuggestion[]>;
  recordUsage(tenantId: string, suggestionId: string): Promise<void>;
}

/** One key and one Lua invocation keep this operation atomic and Cluster-safe. */
export const ASSISTANT_SUGGESTION_SCRIPT = `
local key = KEYS[1]
local mode = ARGV[1]
if mode == 'record' then
  redis.call('ZINCRBY', key, 1, ARGV[2])
  redis.call('ZREMRANGEBYRANK', key, 0, -tonumber(ARGV[3]) - 1)
  redis.call('EXPIRE', key, tonumber(ARGV[4]))
  return 1
end
if mode == 'list' then
  return redis.call('ZREVRANGE', key, 0, tonumber(ARGV[2]) - 1, 'WITHSCORES')
end
return redis.error_reply('unsupported_assistant_suggestion_operation')
`;

function tenantKey(tenantId: string): string {
  if (tenantId.trim().length === 0)
    throw new Error("invalid_suggestion_tenant");
  // Hash-tag only the opaque digest so tenants share no raw identifiers and all
  // keys for a tenant (if added later) remain in the same Redis Cluster slot.
  const digest = createHash("sha256").update(tenantId).digest("hex");
  return `assistant:suggestions:{${digest}}:popular:v1`;
}

function parseRows(value: unknown): Array<{ id: string; score: number }> {
  if (!Array.isArray(value) || value.length % 2 !== 0)
    throw new Error("invalid_assistant_suggestion_reply");
  const rows: Array<{ id: string; score: number }> = [];
  for (let i = 0; i < value.length; i += 2) {
    const id = value[i];
    const rawScore = value[i + 1];
    const score = Number(rawScore);
    if (typeof id !== "string" || !Number.isFinite(score))
      throw new Error("invalid_assistant_suggestion_reply");
    rows.push({ id, score });
  }
  return rows;
}

/**
 * Redis is the fast, expiring popularity layer. It is deliberately fail-closed:
 * callers should return an unavailable response if Redis cannot be reached.
 * Durable analytics should be emitted separately through the application's
 * outbox/event path; this store never performs a synchronous Postgres write.
 */
export function redisAssistantSuggestionStore(
  redis: AssistantSuggestionRedis,
): AssistantSuggestionStore {
  return {
    async list(tenantId, requestedLimit = DEFAULT_LIMIT) {
      const limit = Math.max(
        1,
        Math.min(
          MAX_LIMIT,
          Math.floor(
            Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_LIMIT,
          ),
        ),
      );
      const key = tenantKey(tenantId);
      const rows = parseRows(
        await redis.eval(ASSISTANT_SUGGESTION_SCRIPT, {
          keys: [key],
          arguments: ["list", String(limit)],
        }),
      );

      // Ignore unknown Redis members and return only static, code-owned labels.
      const scores = new Map<string, number>();
      for (const row of rows) {
        if (CATALOG_BY_ID.has(row.id)) scores.set(row.id, row.score);
      }
      return [...ASSISTANT_SUGGESTIONS]
        .sort((a, b) => {
          const scoreDelta = (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
          if (scoreDelta !== 0) return scoreDelta;
          return (
            ASSISTANT_SUGGESTIONS.findIndex((item) => item.id === a.id) -
            ASSISTANT_SUGGESTIONS.findIndex((item) => item.id === b.id)
          );
        })
        .slice(0, limit)
        .map(({ id, label }) => ({ id, label }));
    },

    async recordUsage(tenantId, suggestionId) {
      if (!CATALOG_BY_ID.has(suggestionId))
        throw new Error("unknown_assistant_suggestion");
      await redis.eval(ASSISTANT_SUGGESTION_SCRIPT, {
        keys: [tenantKey(tenantId)],
        arguments: [
          "record",
          suggestionId,
          String(MAX_RETAINED_MEMBERS),
          String(KEY_TTL_SECONDS),
        ],
      });
    },
  };
}
