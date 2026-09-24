import { compose, databases, connectorConfig } from "./events-lib.mjs";

// Match events-smoke's administrator psql helper; no credentials in output.
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
export function checkWAL({
  query = sql,
  config = connectorConfig,
  env = process.env,
  log = console,
} = {}) {
  let failed = false;
  if (
    env.WAL_WARN_BYTES !== undefined &&
    !/^[1-9]\d*$/.test(env.WAL_WARN_BYTES)
  ) {
    throw new Error("WAL_WARN_BYTES must be a positive integer byte count");
  }
  for (const database of databases) {
    if (checkDatabase(database, query, config, env, log)) failed = true;
  }
  return failed ? 1 : 0;
}

function checkDatabase(database, query, config, env, log) {
  let failed = false;
  const cap = BigInt(
    query(
      database,
      "SELECT pg_size_bytes(current_setting('max_slot_wal_keep_size'));",
    ),
  );
  if (cap <= 0n)
    throw new Error(
      `${database}: max_slot_wal_keep_size must be bounded and positive`,
    );
  const warn = env.WAL_WARN_BYTES ? BigInt(env.WAL_WARN_BYTES) : cap / 2n;
  if (warn >= cap)
    throw new Error("WAL_WARN_BYTES must be below the effective WAL cap");
  log.log(`${database}: cap_bytes=${cap} warn_bytes=${warn}`);
  const output = query(
    database,
    `SELECT json_build_object('slot',slot_name,'active',active,'wal_status',wal_status,'retained_bytes',pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)::text) FROM pg_replication_slots WHERE database=current_database() ORDER BY slot_name;`,
  );
  const slots = output
    ? output.split("\n").map((line) => JSON.parse(line))
    : [];
  const expected = config(database)["slot.name"];
  if (!slots.some((slot) => slot.slot === expected)) {
    if (slots.length === 0 && env.WAL_ALLOW_EMPTY_STACK === "1") {
      log.log(`${database}: empty stack explicitly allowed`);
    } else {
      log.error(`${database}: missing expected replication slot ${expected}`);
      failed = true;
    }
  }
  for (const slot of slots) {
    if (checkSlot(database, slot, warn, log)) failed = true;
  }
  return failed;
}
if (import.meta.main) process.exitCode = checkWAL();

function checkSlot(database, slot, warn, log) {
  log.log(JSON.stringify({ database, ...slot }));
  if (
    ["lost", "unreserved"].includes(slot.wal_status) ||
    slot.retained_bytes === null ||
    BigInt(slot.retained_bytes) > warn
  ) {
    log.error(`${database}/${slot.slot}: WAL retention alert`);
    return true;
  }
  return false;
}
