import assert from "node:assert/strict";
import test from "node:test";
import { stage07Endpoints } from "./stage07-endpoints.mjs";

test("Stage 07 defaults to its loopback Kafka and MQTT endpoints", () => {
  assert.deepEqual(stage07Endpoints({}), {
    kafkaBrokers: ["127.0.0.1:59092"],
    mqttBrokerUrl: "tcp://127.0.0.1:51883",
  });
});

test("Stage 07 permits isolated loopback endpoint overrides", () => {
  assert.deepEqual(
    stage07Endpoints({
      STAGE07_KAFKA_BROKERS: "127.0.0.1:59093,localhost:59094",
      STAGE07_MQTT_BROKER_URL: "tcp://127.0.0.1:51884",
    }),
    {
      kafkaBrokers: ["127.0.0.1:59093", "localhost:59094"],
      mqttBrokerUrl: "tcp://127.0.0.1:51884",
    },
  );
});

test("Stage 07 accepts IPv6 loopback endpoints", () => {
  assert.deepEqual(
    stage07Endpoints({
      STAGE07_KAFKA_BROKERS: "[::1]:59094",
      STAGE07_MQTT_BROKER_URL: "tcp://[::1]:51885",
    }),
    {
      kafkaBrokers: ["[::1]:59094"],
      mqttBrokerUrl: "tcp://[::1]:51885",
    },
  );
});

test("Stage 07 refuses remote, credentialed, malformed, and non-TCP endpoints", () => {
  for (const env of [
    { STAGE07_KAFKA_BROKERS: "broker.example:9092" },
    { STAGE07_KAFKA_BROKERS: "user:password@127.0.0.1:9092" },
    { STAGE07_KAFKA_BROKERS: "127.0.0.1:9092/path" },
    { STAGE07_KAFKA_BROKERS: "127.0.0.1:9092," },
    { STAGE07_MQTT_BROKER_URL: "tls://127.0.0.1:8883" },
    { STAGE07_MQTT_BROKER_URL: "tcp://mqtt.example:1883" },
  ]) {
    assert.throws(() => stage07Endpoints(env));
  }
});
