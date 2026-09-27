import { test } from "node:test";
import assert from "node:assert/strict";
import { createApolloServer } from "./schema.js";
import { ReadClient } from "./read-client.js";
import { ProvisioningClient } from "./provisioning.js";
test("ENT-06 GraphQL preserves Read API entitlement denial", async () => {
  const server = createApolloServer();
  const result = await server.executeOperation(
    {
      query:
        '{ readingHistory(deviceId:"d1",from:"2026-09-01T00:00:00Z",to:"2026-09-20T00:00:00Z",limit:10) { readingId } }',
    },
    {
      contextValue: {
        principal: {
          tenantId: "11111111-1111-4111-8111-111111111111",
          subject: "alice",
          roles: ["viewer"],
          expiresAt: new Date(Date.now() + 60_000),
        },
        authorization: "Bearer verified",
        provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
        read: new ReadClient("http://127.0.0.1:4001", async () =>
          Response.json({ code: "entitlement_exceeded" }, { status: 403 }),
        ),
      },
    },
  );
  assert.equal(result.body.kind, "single");
  if (result.body.kind === "single") {
    assert.equal(
      result.body.singleResult.errors?.[0].extensions?.code,
      "entitlement_exceeded",
    );
    assert.equal(
      result.body.singleResult.errors?.[0].extensions?.httpStatus,
      403,
    );
  }
  await server.stop();
});
