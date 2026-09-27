import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { main } from "./seed-cli.js";
import { env } from "./testing/fixtures.js";

const file = fileURLToPath(
  new URL("../../../infra/oidc/memberships.json", import.meta.url),
);

test("the seed command reports an idempotent run and requires its database URL", async () => {
  await assert.rejects(main({}), /CONTROL_DIRECT_URL/);
  const output = await main({
    CONTROL_DIRECT_URL: env("CONTROL_DIRECT_URL"),
    AUTH_MEMBERSHIP_FILE: file,
  });
  assert.match(output, /^seeded memberships: created=\d+ existing=\d+$/);
});
