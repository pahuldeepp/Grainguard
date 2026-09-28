import assert from "node:assert/strict";
import { test } from "node:test";
import Stripe from "stripe";
import { verifyStripeWebhook, InvalidWebhook } from "./webhooks.js";
import { readConfig } from "./config.js";

const secretA = "whsec_firsttestsecret";
const secretB = "whsec_secondtestsecret";
const sdk = new Stripe("sk_test_signature_verification_only");
const body = Buffer.from(JSON.stringify({ id: "evt_test1", object: "event", created: 1,
  type: "customer.subscription.created", data: { object: { id: "sub_test" } } }));

test("B01 rejects a bad webhook signature before storage", () => {
  const now = Date.now();
  const signed = sdk.webhooks.generateTestHeaderString({ payload: body.toString("utf8"),
    secret: secretA, timestamp: Math.floor(now / 1000) });
  const tampered = Buffer.from(body.toString().replace("evt_test1", "evt_test2"));
  assert.throws(() => verifyStripeWebhook(tampered, signed, [secretA], now), InvalidWebhook);
});

test("B02 rejects a webhook timestamp outside the five minute window", () => {
  const now = Date.now();
  const signed = sdk.webhooks.generateTestHeaderString({ payload: body.toString("utf8"),
    secret: secretA, timestamp: Math.floor(now / 1000) - 301 });
  assert.throws(() => verifyStripeWebhook(body, signed, [secretA], now), InvalidWebhook);
});

test("B14 refuses live keys at startup", () => {
  assert.throws(() => readConfig({ STRIPE_API_KEY: "sk_live_secret" }), /live keys are forbidden/);
  assert.throws(() => readConfig({ STRIPE_API_KEY: "rk_live_secret" }), /live keys are forbidden/);
});

test("B15 accepts either active signing secret during rotation", () => {
  const now = Date.now();
  for (const active of [secretA, secretB]) {
    const signed = sdk.webhooks.generateTestHeaderString({ payload: body.toString("utf8"),
      secret: active, timestamp: Math.floor(now / 1000) });
    assert.equal(verifyStripeWebhook(body, signed, [secretA, secretB], now).id, "evt_test1");
  }
});
