const owners = ["saga", "hardware", "inventory", "telemetry"];
export class Stage07ProcessFailure extends Error {}

function processFailure(
  name,
  child,
  logs,
  context,
  code = child?.exitCode,
  signal = child?.signalCode,
) {
  if (!child)
    return new Stage07ProcessFailure(
      `${context}: ${name} process was not started`,
    );
  return new Stage07ProcessFailure(
    `${context}: ${name} exited unexpectedly (exit=${code} signal=${signal})\n${(logs.get(child.stage07Name ?? name) ?? "no captured stderr").slice(-1000)}`,
  );
}
function assertProcessRunning(name, child, logs, context) {
  if (!child || child.exitCode !== null || child.signalCode !== null)
    throw processFailure(name, child, logs, context);
}
export function assertStage07ProcessesRunning(processes, logs, context) {
  for (const name of owners)
    assertProcessRunning(name, processes[name], logs, context);
}

/** Track failures across replacement during the SIGKILL gate. A requested kill
 * is intentional only if the child actually terminates with SIGKILL and no exit
 * code. Other current participants remain monitored throughout awaited kills. */
export function createStage07ProcessMonitor(processes, logs) {
  const expected = new Set();
  const watched = new Map();
  const failures = new Map();
  const watchCurrent = () => {
    for (const name of owners) {
      const child = processes[name];
      if (!child || watched.has(child)) continue;
      const handler = (code, signal) => {
        if (!expected.has(child) || code !== null || signal !== "SIGKILL") {
          failures.set(
            child,
            processFailure(name, child, logs, "SIGKILL rotation", code, signal),
          );
        }
      };
      child.on("exit", handler);
      watched.set(child, handler);
    }
  };
  const assertRunning = (context) => {
    watchCurrent();
    if (failures.size) throw failures.values().next().value;
    for (const name of owners) {
      if (!expected.has(processes[name]))
        assertProcessRunning(name, processes[name], logs, context);
    }
  };
  watchCurrent();
  return {
    assertRunning,
    async rotate(name, restart, context) {
      assertRunning(context);
      const child = processes[name];
      let onClose, onError;
      const closed = new Promise((resolve) => {
        onClose = (code, signal) => resolve({ code, signal });
        onError = () => resolve({ error: true });
        child.once("close", onClose);
        child.once("error", onError);
      });
      const stopWaiting = () => {
        child.off("close", onClose);
        child.off("error", onError);
      };
      expected.add(child);
      let sent;
      try {
        sent = child.kill("SIGKILL");
      } catch {
        sent = false;
      }
      if (!sent) {
        expected.delete(child);
        // No successful signal request means this termination is never planned.
        const failure = processFailure(
          name,
          child,
          logs,
          `${context}: SIGKILL request refused`,
        );
        failures.set(child, failure);
        stopWaiting();
        throw failure;
      }
      const { code, signal, error } = await closed;
      stopWaiting();
      if (error || code !== null || signal !== "SIGKILL") {
        const failure = processFailure(
          name,
          child,
          logs,
          context,
          code,
          signal,
        );
        failures.set(child, failure);
        throw failure;
      }
      assertRunning(context);
      await restart(name);
      expected.delete(child);
      assertRunning(context);
    },
    close() {
      for (const [child, handler] of watched) child.off("exit", handler);
    },
  };
}
