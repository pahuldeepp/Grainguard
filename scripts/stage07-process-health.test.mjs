import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import {
  assertStage07ProcessesRunning,
  createStage07ProcessMonitor,
} from "./stage07-process-health.mjs";
const names = ["saga", "hardware", "inventory", "telemetry"];
function processes() {
  return Object.fromEntries(
    names.map((name) => [name, { exitCode: null, signalCode: null }]),
  );
}
test("healthy current processes pass without restarting them", () => {
  assert.doesNotThrow(() =>
    assertStage07ProcessesRunning(processes(), new Map(), "kill gate"),
  );
});
test("unexpected exit of every current owner fails immediately with context", () => {
  for (const name of names)
    for (const [exitCode, signalCode] of [
      [1, null],
      [0, null],
      [null, "SIGKILL"],
      [null, "SIGTERM"],
    ]) {
      const current = processes();
      current[name] = { exitCode, signalCode };
      assert.throws(
        () =>
          assertStage07ProcessesRunning(
            current,
            new Map([[name, "worker failure"]]),
            "kill gate state=reserving/v2",
          ),
        {
          message: `kill gate state=reserving/v2: ${name} exited unexpectedly (exit=${exitCode} signal=${signalCode})\nworker failure`,
        },
      );
    }
});
test("intentional rotation checks only the current replacement and its named log", () => {
  const current = processes();
  const replaced = {
    exitCode: null,
    signalCode: "SIGKILL",
    stage07Name: "saga-old",
  };
  const logs = new Map([
    ["saga-old", "intentional SIGKILL"],
    [
      "saga-new",
      "invalid tenant placement route: expired after transaction begin",
    ],
  ]);
  current.saga = { exitCode: null, signalCode: null, stage07Name: "saga-new" };
  assert.doesNotThrow(() =>
    assertStage07ProcessesRunning(current, logs, "rotation"),
  );
  assert.equal(replaced.signalCode, "SIGKILL");
  current.saga.exitCode = 1;
  assert.throws(
    () => assertStage07ProcessesRunning(current, logs, "rotation"),
    /saga exited unexpectedly.*\ninvalid tenant placement route: expired after transaction begin/,
  );
});
test("missing child and oversized stderr produce bounded diagnostics", () => {
  const missing = processes();
  delete missing.inventory;
  assert.throws(
    () => assertStage07ProcessesRunning(missing, new Map(), "rotation"),
    /inventory process was not started/,
  );
  const current = processes();
  current.telemetry.exitCode = 1;
  assert.throws(
    () =>
      assertStage07ProcessesRunning(
        current,
        new Map([["telemetry", "X".repeat(5000)]]),
        "rotation",
      ),
    (error) =>
      error.message.endsWith("X".repeat(1000)) && error.message.length < 1200,
  );
});

test("actual SIGKILL gate rejects an owner exit during another owner kill before replacing it", async () => {
  const fixture = actualGateFixture("other-owner-exit");
  await assert.rejects(
    fixture.run(),
    /hardware exited unexpectedly \(exit=1 signal=null\)/,
  );
  assert.equal(fixture.restarted.includes("hardware"), false);
  assert.equal(fixture.completed, false);
});
test("actual SIGKILL gate rejects a natural exit racing a successful signal request", async () => {
  const fixture = actualGateFixture("natural-exit-race");
  await assert.rejects(
    fixture.run(),
    /saga exited unexpectedly \(exit=1 signal=null\)/,
  );
  assert.deepEqual(fixture.restarted, []);
  assert.equal(fixture.completed, false);
});
test("actual SIGKILL gate still accepts confirmed deliberate SIGKILL for each current replacement", async () => {
  const fixture = actualGateFixture("intentional");
  await fixture.run();
  assert.deepEqual(fixture.restarted, names);
  assert.equal(fixture.completed, true);
});
test("rotation retains unexpected exit records even if a process reference is replaced", async () => {
  const current = Object.fromEntries(
    names.map((name) => [name, new FixtureChild(name)]),
  );
  const monitor = createStage07ProcessMonitor(current, new Map());
  try {
    current.hardware.finish(1, null);
    current.hardware = new FixtureChild("hardware-new");
    assert.throws(
      () => monitor.assertRunning("after replacement"),
      /hardware exited unexpectedly/,
    );
  } finally {
    monitor.close();
  }
});
test("refused SIGKILL never waits forever or restarts a child and releases only its own listeners", async () => {
  const current = Object.fromEntries(
    names.map((name) => [name, new FixtureChild(name)]),
  );
  current.saga.kill = () => false;
  const externalClose = () => {};
  current.saga.on("close", externalClose);
  const monitor = createStage07ProcessMonitor(current, new Map());
  try {
    await assert.rejects(
      monitor.rotate(
        "saga",
        () => assert.fail("unexpected replacement"),
        "rotation",
      ),
      /SIGKILL request refused/,
    );
    assert.equal(current.saga.listenerCount("error"), 0);
    assert.deepEqual(current.saga.listeners("close"), [externalClose]);
  } finally {
    monitor.close();
  }
});

// Exercise the actual gate body with event-emitting child fixtures rather than
// mirroring its orchestration in a test. No service or broker is launched.
class FixtureChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  constructor(name, onKill = () => {}) {
    super();
    this.stage07Name = name;
    this.onKill = onKill;
  }
  finish(code, signal) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
  kill(signal) {
    this.onKill(this);
    queueMicrotask(() => {
      if (this.exitCode === null && this.signalCode === null)
        this.finish(null, signal);
    });
    return true;
  }
}
function actualGateFixture(mode) {
  const source = readFileSync(
    new URL("./stage07-e2e.mjs", import.meta.url),
    "utf8",
  );
  const gateBody = source.slice(
    source.indexOf("async function gateKill()"),
    source.indexOf("async function gateOutage()"),
  );
  // The original path had a local kill9 function; include it when running the
  // same regression against the saved pre-fix source to prove its failure.
  const killStart = source.indexOf("async function kill9(");
  const killBody =
    killStart < 0
      ? ""
      : source.slice(
          killStart,
          source.indexOf("async function restart(", killStart),
        );
  const current = Object.fromEntries(
    names.map((name) => [name, new FixtureChild(name)]),
  );
  current.saga.onKill = (child) => {
    if (mode === "other-owner-exit") current.hardware.finish(1, null);
    if (mode === "natural-exit-race") child.finish(1, null);
  };
  const restarted = [];
  const out = {};
  let polls = 0;
  const status = async () =>
    ++polls === 1
      ? { State: "reserving", Version: 1 }
      : { State: "active", Version: 2 };
  const restart = async (name) => {
    restarted.push(name);
    current[name] = new FixtureChild(`${name}-replacement`);
  };
  const waitState = async (
    _item,
    _saga,
    _states,
    _label,
    _timeout,
    assertRunning,
  ) => assertRunning?.();
  const run = Function(
    "gate",
    "provision",
    "procs",
    "logs",
    "status",
    "restart",
    "waitState",
    "assertNoDuplicates",
    "delay",
    "out",
    "createStage07ProcessMonitor",
    "assertStage07ProcessesRunning",
    "exited",
    `${killBody}\n${gateBody}\nreturn gateKill;`,
  )(
    { kill: {} },
    async () => "saga-id",
    current,
    new Map(),
    status,
    restart,
    waitState,
    async () => {
      if (mode === "final-duplicate-exit") current.hardware.finish(1, null);
      return {};
    },
    async () => {},
    out,
    createStage07ProcessMonitor,
    assertStage07ProcessesRunning,
    (child) => child.exitCode !== null || child.signalCode !== null,
  );
  return {
    run,
    restarted,
    get completed() {
      return Boolean(out.kill);
    },
  };
}

test("actual SIGKILL gate rejects an owner exit during the final awaited duplicate check", async () => {
  const fixture = actualGateFixture("final-duplicate-exit");
  await assert.rejects(
    fixture.run(),
    /hardware exited unexpectedly \(exit=1 signal=null\)/,
  );
  assert.equal(fixture.completed, false);
});
