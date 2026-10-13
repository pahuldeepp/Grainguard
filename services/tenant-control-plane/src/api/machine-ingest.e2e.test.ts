import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import { createControlPlaneApp } from "../app.js";
import {
  runtimeDb,
  uniqueSubject,
  activateTenantFixture,
} from "../testing/fixtures.js";

async function goAdmission(env: Record<string, string>) {
  const cwd = fileURLToPath(
    new URL("../../../telemetry-ingest/", import.meta.url),
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "go",
      ["test", "-run", "^TestMachineAuthLiveControlPlane$", "-count=1", "."],
      { cwd, env: { ...process.env, ...env } },
    );
    let output = "";
    child.stdout.on("data", (d) => {
      output += String(d);
    });
    child.stderr.on("data", (d) => {
      output += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Go admission test failed (${code}): ${output.slice(-2000)}`,
            ),
          ),
    );
  });
}

test(
  "real Go ingest admission calls control plane for two-tenant keys and M2M revocation",
  { timeout: 60000 },
  async () => {
    const issuer = await createTestIssuer();
    const db = runtimeDb(5);
    const lookupToken = "machine-live-lookup";
    const app = await createControlPlaneApp({
      db,
      lookupToken,
      apiKeyPepper:
        "a long server side pepper for testing only, more than 32 bytes",
      auth: {
        issuer: issuer.issuer,
        audience: issuer.audience,
        keys: { getKey: issuer.getKey },
      },
      m2m: {
        issuer: issuer.issuer,
        audience: issuer.audience,
        getKey: issuer.getKey,
      },
    });
    await app.listen(0, "127.0.0.1");
    try {
      const base = await app.getUrl();
      const actorSubject = uniqueSubject("machine-live-admin");
      const actor = await issuer.sign({ sub: actorSubject });
      const otherSubject = uniqueSubject("machine-live-other-admin");
      const otherActor = await issuer.sign({ sub: otherSubject });
      async function call(path: string, body: object, token = actor) {
        const response = await fetch(new URL(path, base), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify(body),
        });
        const result = (await response.json()) as Record<string, unknown>;
        assert.ok(response.ok, JSON.stringify(result));
        return result;
      }
      const a = (await call("/v1/organizations", { name: "Machine tenant A" }))
        .tenantId as string;
      const b = (
        await call(
          "/v1/organizations",
          { name: "Machine tenant B" },
          otherActor,
        )
      ).tenantId as string;
      await activateTenantFixture(
        db,
        { issuer: issuer.issuer, subject: actorSubject },
        a,
        {
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      );
      await activateTenantFixture(
        db,
        { issuer: issuer.issuer, subject: otherSubject },
        b,
        {
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      );
      const device = randomUUID(),
        otherDevice = randomUUID();
      const key = await call(`/v1/organizations/${a}/credentials/api-keys`, {
        name: "machine device",
        kind: "dev",
        deviceId: device,
        scopes: ["write:telemetry"],
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });
      const clientId = uniqueSubject("machine-live-client");
      const oauth = await call(
        `/v1/organizations/${a}/credentials/oauth-clients`,
        {
          name: "enterprise",
          issuer: issuer.issuer,
          clientId,
          scopes: ["write:telemetry"],
        },
      );
      const m2m = await issuer.sign({
        sub: `${clientId}@clients`,
        azp: clientId,
        gty: "client-credentials",
        scope: "write:telemetry",
        tenant_id: b,
        gg_tenant: a,
      });
      const goEnv = {
        TEST_CONTROL_PLANE_URL: base,
        TEST_CONTROL_LOOKUP_TOKEN: lookupToken,
        TEST_EXPECTED_TENANT: a,
        TEST_DEVICE_ID: device,
        TEST_OTHER_DEVICE_ID: otherDevice,
        TEST_API_KEY: key.key as string,
        TEST_M2M_TOKEN: m2m,
      };
      await goAdmission(goEnv);
      await call(
        `/v1/organizations/${a}/credentials/${key.principalId}/revoke`,
        {},
      );
      await goAdmission({ ...goEnv, TEST_REVOCATION_STAGE: "key" });
      await call(
        `/v1/organizations/${a}/credentials/${oauth.principalId}/revoke`,
        {},
      );
      await goAdmission({ ...goEnv, TEST_REVOCATION_STAGE: "both" });
    } finally {
      await app.close();
    }
  },
);
