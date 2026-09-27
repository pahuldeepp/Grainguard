import type { MembershipChange } from "./cache.js";

// A Redis client or cluster with the standard node-redis eval/get methods. The Lua
// comparison uses decimal strings: PostgreSQL bigint versions exceed JS safe integers.
export interface RedisVersionClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export interface MembershipVersionStore {
  floor(identityId: string, tenantId: string): Promise<bigint>;
  advance(change: MembershipChange): Promise<void>;
}

const ADVANCE = `
local old = redis.call('GET', KEYS[1])
local next = ARGV[1]
if not old or string.len(next) > string.len(old) or
  (string.len(next) == string.len(old) and next > old) then
  redis.call('SET', KEYS[1], next, 'PX', 600000)
end
return 1
`;

const keyFor = (identityId: string, tenantId: string) =>
  `greenguard:membership:{${identityId}}:${tenantId}:version`;

export function createRedisMembershipVersionStore(
  redis: RedisVersionClient,
): MembershipVersionStore {
  return {
    async floor(identityId, tenantId) {
      const value = await redis.get(keyFor(identityId, tenantId));
      if (value === null) return 0n;
      if (!/^[1-9]\d{0,18}$/.test(value))
        throw new Error("invalid Redis membership version");
      return BigInt(value);
    },
    async advance(change) {
      await redis.eval(ADVANCE, {
        keys: [keyFor(change.identityId, change.tenantId)],
        arguments: [change.version.toString()],
      });
    },
  };
}
