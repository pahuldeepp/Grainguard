import assert from "node:assert/strict";
import test from "node:test";
import { collect, render, escapeLabel } from "./streaming-state-exporter.mjs";

const status = {
  "inventory-outbox": {
    status: {
      connector: { state: "RUNNING" },
      tasks: [{ id: 0, state: "RUNNING" }],
    },
  },
  "risk-outbox": {
    status: {
      connector: { state: "RUNNING" },
      tasks: [
        { id: 0, state: "FAILED" },
        { id: 1, state: "RUNNING" },
      ],
    },
  },
};

test("render emits one-hot connector state and task state counts", () => {
  const text = render({ connectUp: 1, registryUp: 1, connectors: status });
  assert.match(text, /^greenguard_connect_up 1$/m);
  assert.match(text, /^greenguard_schema_registry_up 1$/m);
  assert.match(
    text,
    /^greenguard_connect_connector_state\{connector="inventory-outbox",state="RUNNING"\} 1$/m,
  );
  assert.match(
    text,
    /^greenguard_connect_connector_state\{connector="inventory-outbox",state="FAILED"\} 0$/m,
  );
  assert.match(
    text,
    /^greenguard_connect_task_state\{connector="risk-outbox",state="FAILED"\} 1$/m,
  );
  assert.match(
    text,
    /^greenguard_connect_task_state\{connector="risk-outbox",state="RUNNING"\} 1$/m,
  );
  assert.match(
    text,
    /^greenguard_connect_connector_tasks\{connector="risk-outbox"\} 2$/m,
  );
});

test("render reports Connect down without connector series", () => {
  const text = render({ connectUp: 0, registryUp: 0, connectors: {} });
  assert.match(text, /^greenguard_connect_up 0$/m);
  assert.match(text, /^greenguard_schema_registry_up 0$/m);
  assert.doesNotMatch(text, /connector_state\{/);
});

test("unknown states are still visible and labels are escaped", () => {
  const text = render({
    connectUp: 1,
    registryUp: 1,
    connectors: {
      'we"ird': { status: { connector: { state: "WEIRD" }, tasks: [] } },
    },
  });
  assert.match(text, /connector="we\\"ird",state="WEIRD"\} 1/);
  assert.equal(escapeLabel('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
});

test("collect maps HTTP failures to down instead of throwing", async () => {
  const fetchStub = async (url) => {
    if (String(url).includes("/connectors")) throw new Error("ECONNREFUSED");
    return { ok: false, status: 503 };
  };
  const state = await collect({
    connectUrl: "http://connect:8083",
    registryUrl: "http://registry:8081",
    fetchImpl: fetchStub,
  });
  assert.deepEqual(state, { connectUp: 0, registryUp: 0, connectors: {} });
});

test("collect reads expanded connector status and registry subjects", async () => {
  const seen = [];
  const fetchStub = async (url) => {
    seen.push(String(url));
    if (String(url).includes("/connectors"))
      return { ok: true, json: async () => status };
    return { ok: true, json: async () => [] };
  };
  const state = await collect({
    connectUrl: "http://connect:8083",
    registryUrl: "http://registry:8081",
    fetchImpl: fetchStub,
  });
  assert.equal(state.connectUp, 1);
  assert.equal(state.registryUp, 1);
  assert.deepEqual(Object.keys(state.connectors), [
    "inventory-outbox",
    "risk-outbox",
  ]);
  assert.ok(seen.includes("http://connect:8083/connectors?expand=status"));
  assert.ok(seen.includes("http://registry:8081/subjects"));
});
