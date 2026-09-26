import test from "node:test";
import assert from "node:assert/strict";
import {
  allConnectorConfigs,
  validateSharedDatabaseHeartbeatConfigs,
} from "./events-lib.mjs";

test("checked-in connector configs pass shared-heartbeat validation", () => {
  assert.doesNotThrow(() =>
    validateSharedDatabaseHeartbeatConfigs(allConnectorConfigs()),
  );
});

test("shared database connectors exclude logical heartbeat messages", () => {
  assert.throws(
    () =>
      validateSharedDatabaseHeartbeatConfigs({
        "notification-contacts": {
          "database.dbname": "greenguard_control",
          "heartbeat.interval.ms": "30000",
          "heartbeat.action.query": "SELECT pg_logical_emit_message(...) ",
          "message.prefix.include.list":
            "greenguard\\.notification-contacts-feed",
        },
        "control-outbox": {
          "database.dbname": "greenguard_control",
          "heartbeat.interval.ms": "0",
        },
      }),
    /control-outbox shares greenguard_control.*message\.prefix\.exclude\.list/,
  );
});

test("dedicated heartbeat connector and separate databases validate", () => {
  assert.doesNotThrow(() =>
    validateSharedDatabaseHeartbeatConfigs({
      "inventory-outbox": {
        "database.dbname": "greenguard_inventory",
        "heartbeat.interval.ms": "30000",
        "heartbeat.action.query": "SELECT pg_logical_emit_message(...) ",
        "message.prefix.include.list": "greenguard\\.binding-feed",
      },
      "telemetry-outbox": {
        "database.dbname": "greenguard_telemetry",
        "heartbeat.interval.ms": "0",
      },
    }),
  );
});
