import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import kafkaJs from "kafkajs";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import { identityKey, startMembershipRuntime } from "./index.js";

const live = process.env.STAGE09_MEMBERSHIP_LIVE === "1";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test(
  "live Kafka event invalidates two Redis-backed verifier replicas",
  { skip: !live },
  async () => {
    const issuer = await createTestIssuer();
    const jwks = await issuer.serveJwks();
    let revoked = false;
    const control = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer lookup-secret") {
        res.writeHead(401).end();
        return;
      }
      const subject = new URL(req.url!, "http://localhost").searchParams.get(
        "subject",
      );
      if (subject !== "alice" && subject !== "bob") {
        res.writeHead(404).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          subject === "bob"
            ? { tenantId: B, roles: ["viewer"], version: "1", state: "active" }
            : revoked
              ? { tenantId: A, roles: [], version: "2", state: "revoked" }
              : {
                  tenantId: A,
                  roles: ["operator"],
                  version: "1",
                  state: "active",
                },
        ),
      );
    });
    await new Promise<void>((resolve) =>
      control.listen(0, "127.0.0.1", resolve),
    );
    const port = (control.address() as AddressInfo).port;
    const env: Record<string, string> = {
      AUTH_MEMBERSHIP_SOURCE: "control-plane",
      CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
      CONTROL_LOOKUP_TOKEN: "lookup-secret",
      AUTH_ISSUER: issuer.issuer,
      AUTH_AUDIENCE: issuer.audience,
      AUTH_JWKS_URL: jwks.url,
      AUTH_MEMBERSHIP_KAFKA_BROKERS:
        process.env.STAGE09_KAFKA_BROKERS ?? "127.0.0.1:59092",
      AUTH_MEMBERSHIP_REDIS_CLUSTER_NODES: [1, 2, 3, 4, 5, 6]
        .map((n) => `redis://127.0.0.1:710${n}`)
        .join(","),
      AUTH_MEMBERSHIP_REDIS_NODE_ADDRESS_MAP: [1, 2, 3, 4, 5, 6]
        .map((n) => `redis-node-${n}:6379=127.0.0.1:710${n}`)
        .join(","),
    };
    const getenv = (key: string) => env[key];
    const first = await startMembershipRuntime(
      getenv,
      () => "",
      "stage09-live-a",
    );
    const second = await startMembershipRuntime(
      getenv,
      () => "",
      "stage09-live-b",
    );
    const kafka = new kafkaJs.Kafka({
      clientId: "stage09-live-producer",
      brokers: env.AUTH_MEMBERSHIP_KAFKA_BROKERS!.split(","),
    });
    const producer = kafka.producer({ allowAutoTopicCreation: false });
    try {
      await producer.connect();
      // Allow both fresh consumer groups to receive their partition assignments.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const alice = `Bearer ${await issuer.sign({ sub: "alice", tenant_id: B, roles: ["admin"] })}`;
      const bob = `Bearer ${await issuer.sign({ sub: "bob", tenant_id: A, roles: ["admin"] })}`;
      for (const runtime of [first, second]) {
        const member = await runtime.verify(alice);
        assert.equal(member.tenantId, A);
        assert.deepEqual(member.roles, ["operator"]);
        assert.equal((await runtime.verify(bob)).tenantId, B);
      }
      revoked = true;
      const event = {
        event_id: "33333333-3333-4333-8333-333333333333",
        event_type: "membership.changed",
        schema_version: 1,
        tenant_id: A,
        aggregate_type: "membership",
        aggregate_id: "44444444-4444-4444-8444-444444444444",
        aggregate_version: "2",
        occurred_at: new Date().toISOString(),
        correlation_id: "55555555-5555-4555-8555-555555555555",
        causation_id: "66666666-6666-4666-8666-666666666666",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
        payload: {
          membership_id: "44444444-4444-4444-8444-444444444444",
          membership_version: "2",
          identity_id: identityKey(issuer.issuer, "alice"),
          role: "operator",
          state: "revoked",
          action: "revoked",
          effective_at: new Date().toISOString(),
          actor_identity_id: "77777777-7777-4777-8777-777777777777",
        },
      };
      await producer.send({
        topic: "greenguard.inventory.tenant.v1",
        messages: [{ key: A, value: JSON.stringify(event) }],
      });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const results = await Promise.allSettled([
          first.verify(alice),
          second.verify(alice),
        ]);
        if (
          results.every(
            (result) =>
              result.status === "rejected" &&
              typeof result.reason === "object" &&
              result.reason !== null &&
              "status" in result.reason &&
              result.reason.status === 403,
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (const runtime of [first, second]) {
        await assert.rejects(
          runtime.verify(alice),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            error.status === 403,
        );
        assert.equal((await runtime.verify(bob)).tenantId, B);
      }
    } finally {
      await Promise.allSettled([
        producer.disconnect(),
        first.close(),
        second.close(),
        jwks.close(),
      ]);
      await new Promise<void>((resolve) => control.close(() => resolve()));
    }
  },
);
