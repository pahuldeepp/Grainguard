import assert from "node:assert/strict";
import { test } from "node:test";
import { createSagaMtlsClient } from "./saga-mtls.js";

test("saga mTLS is opt-in and rejects partial or cleartext configuration", () => {
  assert.equal(createSagaMtlsClient({}, "http://127.0.0.1:8092"), null);
  assert.throws(
    () =>
      createSagaMtlsClient(
        { SAGA_MTLS_CA_FILE: "ca.pem" },
        "https://saga.example",
      ),
    /must be set together/,
  );
  assert.throws(
    () =>
      createSagaMtlsClient(
        {
          SAGA_MTLS_CA_FILE: "ca.pem",
          SAGA_MTLS_CERT_FILE: "cert.pem",
          SAGA_MTLS_KEY_FILE: "key.pem",
        },
        "http://127.0.0.1:8092",
      ),
    /requires an HTTPS/,
  );
});
