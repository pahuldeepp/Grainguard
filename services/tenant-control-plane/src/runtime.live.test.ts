import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import { startMembershipRuntime } from "@greenguard/membership-client";
import { createControlPlaneApp } from "./app.js";
import { createDb } from "./db/client.js";
import {
  acceptInvitation,
  createOrganization,
  inviteMember,
  revokeMember,
} from "./domain/store.js";

test(
  "committed revoke reaches two verifiers through CDC and Kafka",
  {
    skip: process.env.STAGE09_MEMBERSHIP_CDC_LIVE !== "1",
  },
  async () => {
    const databaseUrl = process.env.CONTROL_DATABASE_URL;
    const lookupToken = process.env.CONTROL_LOOKUP_TOKEN;
    if (!databaseUrl || !lookupToken)
      throw new Error("CONTROL_DATABASE_URL and CONTROL_LOOKUP_TOKEN required");
    const issuer = await createTestIssuer();
    const jwks = await issuer.serveJwks();
    const db = createDb(databaseUrl);
    const app = await createControlPlaneApp({ db, lookupToken });
    await app.listen(0, "127.0.0.1");
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const env: Record<string, string> = {
      AUTH_MEMBERSHIP_SOURCE: "control-plane",
      CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
      CONTROL_LOOKUP_TOKEN: lookupToken,
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
    const cmd = () => ({
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
    const admin = { issuer: issuer.issuer, subject: `admin-${randomUUID()}` };
    const aliceSubject = `alice-${randomUUID()}`;
    const alice = {
      issuer: issuer.issuer,
      subject: aliceSubject,
      email: `${aliceSubject}@example.test`,
      emailVerified: true,
    };
    const bob = { issuer: issuer.issuer, subject: `bob-${randomUUID()}` };
    let first: Awaited<ReturnType<typeof startMembershipRuntime>> | undefined;
    let second: Awaited<ReturnType<typeof startMembershipRuntime>> | undefined;
    try {
      const a = await createOrganization(
        db,
        admin,
        { name: "CDC runtime A" },
        cmd(),
      );
      const b = await createOrganization(
        db,
        bob,
        { name: "CDC runtime B" },
        cmd(),
      );
      const tenantA = a.body.tenantId as string;
      const tenantB = b.body.tenantId as string;
      const invite = await inviteMember(
        db,
        admin,
        tenantA,
        { email: `${aliceSubject}@example.test`, role: "operator" },
        cmd(),
      );
      const joined = await acceptInvitation(
        db,
        alice,
        { token: invite.body.token as string },
        cmd(),
      );
      const get = (key: string) => env[key];
      first = await startMembershipRuntime(get, () => "", "stage09-cdc-a");
      second = await startMembershipRuntime(get, () => "", "stage09-cdc-b");
      const aliceBearer = `Bearer ${await issuer.sign({ sub: alice.subject, tenant_id: tenantB, roles: ["admin"] })}`;
      const bobBearer = `Bearer ${await issuer.sign({ sub: bob.subject, tenant_id: tenantA, roles: ["admin"] })}`;
      for (const runtime of [first, second]) {
        assert.equal((await runtime.verify(aliceBearer)).tenantId, tenantA);
        assert.equal((await runtime.verify(bobBearer)).tenantId, tenantB);
      }
      const started = Date.now();
      await revokeMember(
        db,
        admin,
        tenantA,
        joined.body.identityId as string,
        BigInt(joined.body.version as string),
        cmd(),
      );
      let deniedAt = 0;
      const deadline = started + 20_000; // Less than the 30-second positive TTL.
      while (Date.now() < deadline) {
        const outcomes = await Promise.allSettled([
          first.verify(aliceBearer),
          second.verify(aliceBearer),
        ]);
        if (
          outcomes.every(
            (o) =>
              o.status === "rejected" &&
              typeof o.reason === "object" &&
              o.reason !== null &&
              "status" in o.reason &&
              o.reason.status === 403,
          )
        ) {
          deniedAt = Date.now();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(
        deniedAt,
        "CDC event did not invalidate both replicas before the cache TTL",
      );
      for (const runtime of [first, second])
        assert.equal((await runtime.verify(bobBearer)).tenantId, tenantB);
      console.log(
        `CDC revocation reached both replicas in ${deniedAt - started} ms`,
      );
    } finally {
      await Promise.allSettled([
        first?.close(),
        second?.close(),
        app.close(),
        jwks.close(),
      ]);
    }
  },
);
