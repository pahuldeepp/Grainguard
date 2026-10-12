import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatFirstAdminResult,
  main,
  validateFirstAdminDatabaseUrl,
  waitForFirstAdminMembership,
} from "./enroll-first-admin-cli.js";

const databaseUrl =
  "postgresql://control_app:secret@control.example:5432/greenguard_control?sslmode=verify-full&sslrootcert=%2Fetc%2Fgreenguard%2Frds%2Fca.pem";

test("first-admin CLI accepts only the mounted TLS-verified control runtime URL", () => {
  assert.equal(validateFirstAdminDatabaseUrl(databaseUrl), databaseUrl);
  for (const invalid of [
    "postgresql://control_app:secret@control.example:5432/greenguard_control",
    databaseUrl.replace("control_app", "tenant_bootstrap_worker"),
    databaseUrl.replace("greenguard_control", "greenguard_billing"),
    databaseUrl.replace(
      "%2Fetc%2Fgreenguard%2Frds%2Fca.pem",
      "%2Flaptop%2Fca.pem",
    ),
    `${databaseUrl}&options=-c%20role=other`,
  ])
    assert.throws(() => validateFirstAdminDatabaseUrl(invalid));
});

test("first-admin wait returns only after exact tenant/admin read-back is active", async () => {
  const tenantId = "00000000-0000-4000-8000-000000000002";
  let currentTime = 0;
  let reads = 0;
  await waitForFirstAdminMembership(
    async () => {
      reads += 1;
      return reads < 3 ? null : { tenantId, roles: ["admin"], state: "active" };
    },
    { tenantId },
    {
      timeoutMs: 10_000,
      pollIntervalMs: 2_000,
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
    },
  );
  assert.equal(reads, 3);
  assert.equal(currentTime, 4_000);
});

test("first-admin wait fails closed on mismatched active membership and timeout", async () => {
  const tenantId = "00000000-0000-4000-8000-000000000002";
  await assert.rejects(
    waitForFirstAdminMembership(
      async () => ({ tenantId, roles: ["viewer"], state: "active" }),
      { tenantId },
      { timeoutMs: 10_000, pollIntervalMs: 1_000 },
    ),
    /did not match requested tenant\/admin/,
  );

  let currentTime = 0;
  await assert.rejects(
    waitForFirstAdminMembership(
      async () => null,
      { tenantId },
      {
        timeoutMs: 1_000,
        pollIntervalMs: 250,
        now: () => currentTime,
        sleep: async (milliseconds) => {
          currentTime += milliseconds;
        },
      },
    ),
    /timed out waiting for active first-admin membership read-back/,
  );
});

test("first-admin wait rejects unbounded and invalid polling limits", async () => {
  await assert.rejects(
    waitForFirstAdminMembership(
      async () => null,
      { tenantId: "tenant" },
      {
        timeoutMs: 3_600_001,
        pollIntervalMs: 1_000,
      },
    ),
    /wait bounds are invalid/,
  );
});

test("verified owner receipt uses issuer-qualified identity and exposes no token or subject", () => {
  const enrollment = {
    tenantId: "00000000-0000-4000-8000-000000000002",
    issuer: "https://example.invalid/dex",
    subject: "opaque-connector-qualified-subject",
  };
  const raw = formatFirstAdminResult(enrollment, "existing", "json");
  const receipt = JSON.parse(raw);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "enrollment",
    "issuer",
    "role",
    "state",
    "tenant_id",
    "user_id",
    "version",
  ]);
  assert.equal(receipt.tenant_id, enrollment.tenantId);
  assert.equal(receipt.state, "active");
  assert.equal(receipt.role, "admin");
  assert.match(receipt.user_id, /^[0-9a-f-]{36}$/);
  assert.ok(!raw.includes(enrollment.subject));
  assert.notEqual(
    receipt.user_id,
    JSON.parse(
      formatFirstAdminResult(
        { ...enrollment, issuer: "https://other.invalid/dex" },
        "existing",
        "json",
      ),
    ).user_id,
  );
  assert.match(
    formatFirstAdminResult(enrollment, "existing", "text"),
    /^OIDC first-admin enrollment: ACTIVE admin membership read-back verified/,
  );
});

test("invalid owner output format fails before token verification or enrollment", async () => {
  await assert.rejects(
    main({ ENROLL_OUTPUT_FORMAT: "unrecognized" }, "not-a-token"),
    /ENROLL_OUTPUT_FORMAT must be text or json/,
  );
});
