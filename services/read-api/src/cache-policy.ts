import type { ReadBackends, postgresReads } from "./backends.js";
import { withoutPostgresCache } from "./backends.js";
import { readContext } from "./consistency.js";

/** Uncertified v1 entries serve only ordinary legacy primary reads. Replica or
 * placement snapshots and explicit minima must use their admitted PG backend.
 */
export function postgresCachePolicy(
  cached: ReadBackends,
  postgres: ReturnType<typeof postgresReads>,
  bypass: boolean,
): ReadBackends {
  const methods = Object.fromEntries(
    Object.entries(postgres).map(([name, origin]) => [
      name,
      (...args: unknown[]) => {
        const context = readContext.getStore();
        const cachedMethod = cached[name as keyof ReadBackends];
        const method =
          bypass ||
          context?.minimum ||
          context?.lease ||
          typeof cachedMethod !== "function"
            ? origin
            : cachedMethod;
        return (method as (...values: unknown[]) => Promise<unknown>)(...args);
      },
    ]),
  ) as ReturnType<typeof postgresReads>;
  return withoutPostgresCache(cached, methods);
}
