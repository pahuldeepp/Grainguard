import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startApi } from "../testing/api.js";

process.env.IDENTITY_DISCOVER_BURST = "3";
process.env.IDENTITY_DISCOVER_PER_MINUTE = "1";
let api: Awaited<ReturnType<typeof startApi>>;
before(async () => {
  api = await startApi();
});
after(() => api.close());

test("discovery answers unknown domains identically, then throttles per IP with Retry-After", async () => {
  const ask = (name: string) =>
    api.call("GET", `/v1/identity/discover?email=x@${name}.example.test`);
  const first = await ask("nobody-one");
  const second = await ask("nobody-two");
  assert.equal(first.status, 200);
  assert.deepEqual([first.status, first.json], [second.status, second.json]);
  await ask("nobody-three");
  const limited = await ask("nobody-four");
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
});
