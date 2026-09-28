import assert from "node:assert/strict";
import test from "node:test";
import { kafkaSecurityFromEnv } from "./index.js";

test("local broker uses no security options", () => {
  assert.deepEqual(
    kafkaSecurityFromEnv(() => undefined),
    {},
  );
});

test("AWS TLS requirement rejects absent or incomplete SASL settings", () => {
  assert.throws(
    () =>
      kafkaSecurityFromEnv((key) =>
        key === "KAFKA_REQUIRE_TLS" ? "true" : undefined,
      ),
    /Kafka requires SASL_SSL/,
  );
  assert.throws(
    () =>
      kafkaSecurityFromEnv(
        (key) =>
          ({
            KAFKA_SECURITY_PROTOCOL: "PLAINTEXT",
            KAFKA_SASL_MECHANISM: "PLAIN",
            KAFKA_SASL_USERNAME: "user",
            KAFKA_SASL_PASSWORD: "password",
            KAFKA_TLS_CA_FILE: "/missing",
          })[key],
      ),
    /Kafka requires SASL_SSL/,
  );
});
