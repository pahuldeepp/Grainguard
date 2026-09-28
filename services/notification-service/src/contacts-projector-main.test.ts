import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { listenWithCleanup, positivePort } from "./contacts-projector-main.js";

test("projector rejects invalid configured ports before startup", () => {
  assert.equal(positivePort(undefined, 8097), 8097);
  assert.equal(positivePort("65535", 8097), 65535);
  for (const value of ["0", "65536", "8080.5", "not-a-port", " "]) {
    assert.throws(() => positivePort(value, 8097), /valid port/);
  }
});

test("projector bind failure cleans up consumer and store before returning", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) =>
    occupied.listen(0, "127.0.0.1", resolve),
  );
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  let cleaned = false;
  try {
    await assert.rejects(
      listenWithCleanup(createServer(), address.port, "127.0.0.1", async () => {
        cleaned = true;
      }),
      /EADDRINUSE/,
    );
    assert.equal(cleaned, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
