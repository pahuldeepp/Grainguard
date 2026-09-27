import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidInputError } from "../domain/errors.js";
import { validateContacts } from "./contacts.js";

test("contacts accept snapshots, normalize omitted channels, and allow an explicit cleared tombstone", () => {
  assert.deepEqual(validateContacts({ email: "alerts+farm@example.test" }), {
    email: "alerts+farm@example.test",
    sms: null,
  });
  assert.deepEqual(validateContacts({ sms: "+12045550123" }), {
    email: null,
    sms: "+12045550123",
  });
  assert.deepEqual(
    validateContacts({ email: "ops@example.test", sms: "+12045550123" }),
    {
      email: "ops@example.test",
      sms: "+12045550123",
    },
  );
  assert.deepEqual(validateContacts({ email: null, sms: null }), {
    email: null,
    sms: null,
  });
});

test("closed contacts validation rejects empty, malformed and injected recipients without echoing values", () => {
  const invalid: unknown[] = [
    null,
    [],
    "ops@example.test",
    {},
    { email: null },
    { email: "" },
    { email: 1 },
    { email: "ops@localhost" },
    { email: "ops @example.test" },
    { email: "a".repeat(310) + "@example.test" },
    { email: "ops@example.test\r\nBcc: attacker@example.test" },
    { email: "ops\0@example.test" },
    { email: "ops\x7f@example.test" },
    { email: "ops@example.test,attacker@example.test" },
    { email: '"ops"@example.test' },
    { email: "<ops@example.test>" },
    { sms: "12045550123" },
    { sms: "+012345678" },
    { sms: "+1234567" },
    { sms: "+1234567890123456" },
    { sms: "+1 2045550123" },
    { sms: 12045550123 },
    { email: "ops@example.test", tenantId: "spoofed-tenant" },
  ];
  for (const input of invalid) {
    assert.throws(
      () => validateContacts(input),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInputError);
        assert.ok(!error.message.includes("example.test"));
        return true;
      },
    );
  }
});
