import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  listenWithCleanup,
  positivePort,
  projectorStartupFailure,
  ProjectorConfigurationError,
  stopProjector,
} from "./contacts-projector-main.js";

test("projector rejects invalid configured ports before startup", () => {
  assert.equal(positivePort(undefined, 8097), 8097);
  assert.equal(positivePort("65535", 8097), 65535);
  for (const value of ["0", "65536", "8080.5", "not-a-port", " "]) {
    assert.throws(() => positivePort(value, 8097), /valid port/);
  }
});

test("projector startup errors expose safe codes and configuration messages only", () => {
  assert.deepEqual(
    projectorStartupFailure(
      Object.assign(new Error("bind failed"), { code: "EADDRINUSE" }),
    ),
    { error_name: "Error", error_code: "EADDRINUSE" },
  );
  assert.deepEqual(
    projectorStartupFailure(
      new ProjectorConfigurationError("PORT is required"),
    ),
    {
      error_name: "ProjectorConfigurationError",
      message: "PORT is required",
    },
  );
  assert.deepEqual(projectorStartupFailure(new Error("token=secret")), {
    error_name: "Error",
  });
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

test("projector shutdown closes HTTP before consumer and store", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const closed: string[] = [];
  const consumer = async () => {
    closed.push("consumer");
  };
  const store = () => {
    closed.push("store");
  };
  await stopProjector(server, consumer, store);
  assert.deepEqual(closed, ["consumer", "store"]);
});
