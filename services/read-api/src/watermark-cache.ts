import { createHash, randomUUID } from "node:crypto";
import {
  parseWatermark,
  serializeWatermark,
  type ProjectionWatermark,
  type ReadLeaseAuthority,
} from "@greenguard/membership-client";
import type { ReadTransaction } from "@greenguard/read-model";
import { EPOCH_KEY, type CacheStore } from "./cache.js";
import type { postgresReads } from "./backends.js";
import {
  assertReadActive,
  readContext,
  recordSnapshotWatermark,
  readWithinBudget,
} from "./consistency.js";
import { FreshnessUnavailable } from "./replicas.js";

const compare = `local function ge(a,b) return #a>#b or (#a==#b and a>=b) end
local function decimal(s)
  return type(s)=='string' and #s<=19 and (s=='0' or string.match(s,'^[1-9][0-9]*$')) and ge('9223372036854775807',s)
end
local function uuid(s)
  return type(s)=='string' and #s==36 and string.match(s,'^[0-9a-f]+%-[0-9a-f]+%-[1-8][0-9a-f]+%-[89ab][0-9a-f]+%-[0-9a-f]+$') and
    string.sub(s,9,9)=='-' and string.sub(s,14,14)=='-' and string.sub(s,19,19)=='-' and string.sub(s,24,24)=='-'
end
local function valid(v)
  if type(v)~='table' or v.v~=1 or not uuid(v.tenantId) or not uuid(v.shardIncarnation) or
    not decimal(v.placementEpoch) or v.placementEpoch=='0' or not decimal(v.sequence) then return false end
  local count=0; for _ in pairs(v) do count=count+1 end; return count==5
end
local function same(a,b) return a.tenantId==b.tenantId and a.shardIncarnation==b.shardIncarnation and a.placementEpoch==b.placementEpoch end
local function decode(s) if not s then return nil end local ok,v=pcall(cjson.decode,s) if not ok or type(v)~='table' then return nil end return v end`;
// No Lua tonumber for BIGINT sequences: exact decimal strings are compared by length.
// Every accessed key is explicitly declared and shares the authenticated tenant slot.
export const WATERMARK_METADATA = `return {redis.call('GET',KEYS[1]) or false,redis.call('GET',KEYS[2]) or false,redis.call('GET',KEYS[3]) or '0'}`;
export const GUARD_INIT = `${compare}
if (redis.call('GET',KEYS[3]) or '0')~=ARGV[4] then return 0 end
local incoming=decode(ARGV[1]); local old=decode(redis.call('GET',KEYS[1]))
if not valid(incoming) or not decimal(ARGV[3]) or not decimal(ARGV[4]) then return 0 end
if not valid(old) then old=nil end
if old and same(old,incoming) and ge(old.sequence,incoming.sequence) then redis.call('SET',KEYS[2],ARGV[3],'PX',ARGV[2]); return 1 end
if old and not same(old,incoming) and not ge(incoming.placementEpoch,old.placementEpoch) then return 0 end
redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2]); redis.call('SET',KEYS[2],ARGV[3],'PX',ARGV[2]); return 1`;
export const WATERMARK_HIT = `${compare}
if redis.call('GET',KEYS[3])~=ARGV[2] or (redis.call('GET',KEYS[4]) or '0')~=ARGV[3] then return nil end
local guard=decode(redis.call('GET',KEYS[1])); local wanted=decode(ARGV[1]); local raw=redis.call('GET',KEYS[2]); local entry=decode(raw)
if not valid(guard) or not valid(wanted) or not entry or not valid(entry.watermark) then return nil end
if not same(guard,wanted) or not same(guard,entry.watermark) or not ge(entry.watermark.sequence,guard.sequence) or not ge(entry.watermark.sequence,wanted.sequence) then return nil end
-- Return the original JSON: Lua cjson re-encoding changes empty arrays and numeric precision.
return raw`;
export const WATERMARK_FILL = `${compare}
if redis.call('GET',KEYS[4])~=ARGV[4] or (redis.call('GET',KEYS[5]) or '0')~=ARGV[5] then return 0 end
local guard=decode(redis.call('GET',KEYS[1])); local entry=decode(ARGV[2])
if redis.call('GET',KEYS[2])~=ARGV[1] or not valid(guard) or not entry or not valid(entry.watermark) or not same(guard,entry.watermark) or not ge(entry.watermark.sequence,guard.sequence) then return 0 end
redis.call('SET',KEYS[3],ARGV[2],'PX',ARGV[3]); redis.call('DEL',KEYS[2]); return 1`;
const UNLOCK = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`;
export const watermarkGuardKey = (tenantId: string) =>
  `gg:read:v2:{t:${tenantId}}:guard`;

const atLeast = (a: ProjectionWatermark, b: ProjectionWatermark) =>
  a.tenantId === b.tenantId &&
  a.shardIncarnation === b.shardIncarnation &&
  a.placementEpoch === b.placementEpoch &&
  BigInt(a.sequence) >= BigInt(b.sequence);

/** Cache metadata is ephemeral. A missing guard is rebuilt only from the owning
 * primary's durable snapshot under an authority lease; notifications cannot
 * manufacture placement. Responses and fills both require that lease.
 */
export function watermarkCacheBackends(
  postgres: ReturnType<typeof postgresReads>,
  store: CacheStore,
  options: {
    authority: ReadLeaseAuthority;
    primaryWatermark(tenantId: string): Promise<ProjectionWatermark>;
    timeoutMs?: number;
  },
): ReturnType<typeof postgresReads> {
  const timeoutMs = options.timeoutMs ?? 100;
  const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
    assertReadActive();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("cache_timeout")),
            timeoutMs,
          );
        }),
      ]);
      assertReadActive();
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
  const decimal = (value: unknown): value is string =>
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9223372036854775807n;
  async function load<T>(
    kind: string,
    args: unknown[],
    origin: () => Promise<T>,
  ): Promise<T> {
    const ctx = readContext.getStore();
    const loadOrigin = async (minimum = ctx?.minimum) => {
      assertReadActive(ctx);
      // Backend methods may run concurrently in one HTTP operation. Each load
      // owns its floor and proof; only completed proofs merge into the response.
      if (!ctx) return { result: await origin(), watermark: undefined };
      const child = {
        ...ctx,
        minimum,
        watermark: undefined as ProjectionWatermark | undefined,
      };
      const result = await readContext.run(child, async () => {
        assertReadActive(child);
        const value = await origin();
        assertReadActive(child);
        return value;
      });
      if (child.watermark) recordSnapshotWatermark(ctx, child.watermark);
      return { result, watermark: child.watermark };
    };
    const activeOrigin = async () => (await loadOrigin()).result;
    assertReadActive(ctx);
    if (!ctx?.lease) return activeOrigin();
    const route = ctx.lease.route;
    const required: ProjectionWatermark = ctx.minimum ?? {
      v: 1,
      tenantId: ctx.tenantId,
      shardIncarnation: route.shardIncarnation,
      placementEpoch: route.placementEpoch,
      sequence: "0",
    };
    const guardKey = watermarkGuardKey(ctx.tenantId);
    const stampKey = `${guardKey}:recovery`,
      revisionKey = `${guardKey}:revision`;
    const hash = createHash("sha256")
      .update(JSON.stringify([kind, args]))
      .digest("hex");
    let key = "",
      lock = "",
      recoveryEpoch = "",
      revision = "";
    const capability = `${ctx.lease.leaseId}:${randomUUID()}`;
    let guard: ProjectionWatermark;
    let hasLock: boolean;
    const metadata = async () => {
      const result = await bounded(() =>
        store.eval(WATERMARK_METADATA, {
          keys: [guardKey, stampKey, revisionKey],
          arguments: [],
        }),
      );
      if (!Array.isArray(result) || result.length !== 3 || !decimal(result[2]))
        throw new Error("invalid_cache_metadata");
      const [current, stamp, currentRevision] = result as [
        string | null,
        string | null,
        string,
      ];
      return {
        guard: current ? parseWatermark(current, ctx.tenantId) : undefined,
        stamp,
        revision: currentRevision,
      };
    };
    try {
      const recovery = await bounded(() => store.get(EPOCH_KEY));
      if (!decimal(recovery)) return activeOrigin();
      recoveryEpoch = recovery;
      let current = await metadata();
      revision = current.revision;
      if (
        !current.guard ||
        current.stamp !== recoveryEpoch ||
        !atLeast(current.guard, { ...required, sequence: "0" })
      ) {
        assertReadActive(ctx);
        const durable = await options.primaryWatermark(ctx.tenantId);
        assertReadActive(ctx);
        if (!atLeast(durable, { ...required, sequence: "0" }))
          throw new FreshnessUnavailable();
        await readWithinBudget(
          () =>
            options.authority.admit(ctx.lease!, {
              deadline: ctx.deadline,
              signal: ctx.signal,
            }),
          ctx.signal,
        );
        assertReadActive(ctx);
        const installed = await bounded(() =>
          store.eval(GUARD_INIT, {
            keys: [guardKey, stampKey, revisionKey],
            arguments: [
              serializeWatermark(durable),
              "600000",
              recoveryEpoch,
              revision,
            ],
          }),
        );
        if (Number(installed) !== 1) return activeOrigin();
        // Init may retain a newer notification guard. Re-read all metadata together
        // so the origin minimum includes that guard, rather than the older primary token.
        current = await metadata();
        if (current.revision !== revision) return activeOrigin();
      }
      if (
        !current.guard ||
        current.stamp !== recoveryEpoch ||
        !atLeast(current.guard, { ...required, sequence: "0" })
      )
        return activeOrigin();
      guard = current.guard;
      key = `gg:read:v2:{t:${ctx.tenantId}}:r:${recoveryEpoch}:n:${revision}:i:${route.shardIncarnation}:e:${route.placementEpoch}:${hash}`;
      lock = `${key}:lock`;
      const hit = await bounded(() =>
        store.eval(WATERMARK_HIT, {
          keys: [guardKey, key, stampKey, revisionKey],
          arguments: [serializeWatermark(required), recoveryEpoch, revision],
        }),
      );
      if (typeof hit === "string") {
        const envelope = JSON.parse(hit) as {
          watermark: ProjectionWatermark;
          data: T;
        };
        const watermark = parseWatermark(
          JSON.stringify(envelope.watermark),
          ctx.tenantId,
        );
        if (!atLeast(watermark, required) || !atLeast(watermark, guard))
          throw new Error("invalid_cache_watermark");
        if ((await bounded(() => store.get(EPOCH_KEY))) !== recoveryEpoch)
          throw new Error("cache_recovery_changed");
        // Cached data is internal; the HTTP boundary admits the complete response.
        assertReadActive(ctx);
        recordSnapshotWatermark(ctx, watermark);
        return envelope.data;
      }
      hasLock =
        (await bounded(() =>
          store.set(lock, capability, {
            PX: Math.max(1, Math.min(1000, ctx.deadline - Date.now())),
            NX: true,
          }),
        )) === "OK";
    } catch {
      // Cancellation must escape instead of starting owner-store fallback work.
      assertReadActive(ctx);
      return activeOrigin();
    }
    const floor =
      BigInt(guard.sequence) > BigInt(required.sequence) ? guard : required;
    try {
      const { result, watermark } = await loadOrigin(floor);
      assertReadActive(ctx);
      if (hasLock && watermark && atLeast(watermark, floor)) {
        const encoded = JSON.stringify({ watermark, data: result });
        if (Buffer.byteLength(encoded) <= 65536) {
          assertReadActive(ctx);
          await readWithinBudget(
            () =>
              options.authority.admit(ctx.lease!, {
                deadline: ctx.deadline,
                signal: ctx.signal,
              }),
            ctx.signal,
          );
          assertReadActive(ctx);
          if (
            (await bounded(() => store.get(EPOCH_KEY)).catch(() => null)) ===
            recoveryEpoch
          ) {
            await bounded(() =>
              store.eval(WATERMARK_FILL, {
                keys: [guardKey, lock, key, stampKey, revisionKey],
                arguments: [
                  capability,
                  encoded,
                  "5000",
                  recoveryEpoch,
                  revision,
                ],
              }),
            ).catch(() => {});
          }
        }
      }
      assertReadActive(ctx);
      return result;
    } finally {
      // Abandoned locks expire; do not dispatch further Redis work after abort.
      if (hasLock && !ctx.signal?.aborted && ctx.deadline > Date.now())
        await bounded(() =>
          store.eval(UNLOCK, { keys: [lock], arguments: [capability] }),
        ).catch(() => {});
    }
  }
  return Object.fromEntries(
    Object.entries(postgres).map(([kind, method]) => [
      kind,
      (...args: unknown[]) =>
        load(kind, args, () =>
          (method as (...args: unknown[]) => Promise<unknown>)(...args),
        ),
    ]),
  ) as ReturnType<typeof postgresReads>;
}

export async function snapshotWatermark(
  tx: ReadTransaction,
  tenantId: string,
): Promise<ProjectionWatermark> {
  const row = (
    await tx.query<{
      shard_incarnation: string;
      placement_epoch: string;
      sequence: string;
    }>(
      `SELECT w.shard_incarnation::text,w.placement_epoch::text,w.sequence::text
     FROM read.projection_watermarks w JOIN greenguard_internal.projection_ownership_snapshot($1::uuid) o
       ON w.shard_incarnation=o.shard_incarnation AND w.placement_epoch=o.placement_epoch
     WHERE w.tenant_id=$1 AND o.state='active'`,
      [tenantId],
    )
  ).rows[0];
  if (!row) throw new FreshnessUnavailable();
  return parseWatermark(
    JSON.stringify({
      v: 1,
      tenantId,
      shardIncarnation: row.shard_incarnation,
      placementEpoch: row.placement_epoch,
      sequence: row.sequence,
    }),
    tenantId,
  );
}
