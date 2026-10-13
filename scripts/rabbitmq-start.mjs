import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const diagnosticLimit = 24_000;

// Omit a whole credential-bearing channel rather than trying to parse unknown
// quoted, escaped, Erlang or header values. Preserve only reviewed classifications.
export function sanitizeRabbitMQDiagnostics(value) {
  const text = String(value);
  if (
    /(?:password|passwd|default_pass|(?:^|[^\w])pass(?:[^\w]|$)|token|secret|credential|cookie|api[_-]?key|authorization|bearer)/i.test(
      text,
    )
  ) {
    return `${/BOOT FAILED/i.test(text) ? "BOOT FAILED " : ""}[redacted credential-bearing diagnostic output]`;
  }
  return text
    .replace(
      /\b(?:amqps?|postgres(?:ql)?|https?):\/\/[^\s"'<>]+/gi,
      "[redacted URL]",
    )
    .slice(-diagnosticLimit);
}

function diagnosticResult(result) {
  return [result.stdout ?? "", result.stderr ?? "", result.error?.message ?? ""]
    .map(sanitizeRabbitMQDiagnostics)
    .join("\n")
    .slice(-diagnosticLimit);
}

function selectedContainerState(state) {
  const timestamp = (value) =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)
      ? value
      : undefined;
  const status = (value) =>
    [
      "created",
      "running",
      "paused",
      "restarting",
      "removing",
      "exited",
      "dead",
      "starting",
      "healthy",
      "unhealthy",
    ].includes(value)
      ? value
      : undefined;
  return {
    status: status(state.Status),
    running: typeof state.Running === "boolean" ? state.Running : undefined,
    exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : undefined,
    oomKilled:
      typeof state.OOMKilled === "boolean" ? state.OOMKilled : undefined,
    // Docker Error is arbitrary text. Presence is useful; its content is never emitted.
    error: state.Error ? "[redacted free-form container error]" : "",
    startedAt: timestamp(state.StartedAt),
    finishedAt: timestamp(state.FinishedAt),
    health: status(state.Health?.Status),
  };
}

/** Preserve the original startup failure while retaining evidence before CI
 * cleanup removes the container. Inspect only State, never Config or Env. */
export function startRabbitMQ(
  composeCommand,
  { run = spawnSync, report = console.error } = {},
) {
  if (composeCommand[0] !== "docker" || composeCommand[1] !== "compose")
    throw new Error("RabbitMQ startup requires docker compose arguments");
  const startup = run(
    "docker",
    [...composeCommand.slice(1), "up", "-d", "--wait", "rabbitmq"],
    { stdio: "inherit" },
  );
  if (!startup.error && startup.status === 0) return 0;
  report(
    "RabbitMQ startup failed; collecting bounded container state and logs before cleanup.",
  );
  const options = { encoding: "utf8", timeout: 20_000, maxBuffer: 256 * 1024 };
  const capture = (args) => {
    try {
      return run("docker", args, options);
    } catch (error) {
      return { status: null, error };
    }
  };
  const found = capture([
    ...composeCommand.slice(1),
    "ps",
    "--all",
    "--quiet",
    "rabbitmq",
  ]);
  const ids = String(found.stdout ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (
    found.error ||
    found.status !== 0 ||
    ids.length !== 1 ||
    !/^[a-f0-9]{12,64}$/.test(ids[0])
  ) {
    report(
      `RabbitMQ container identification unavailable: ${diagnosticResult(found)}`,
    );
    return startup.status || 1;
  }
  const id = ids[0];
  const inspected = capture(["inspect", "--format", "{{json .State}}", id]);
  try {
    if (inspected.error || inspected.status !== 0)
      throw new Error(diagnosticResult(inspected));
    const state = JSON.parse(inspected.stdout);
    report(
      `RabbitMQ container state: ${JSON.stringify(selectedContainerState(state))}`,
    );
  } catch {
    // Parser and Docker errors can include excerpts of arbitrary state text.
    report(
      "RabbitMQ container state unavailable: inspection or parsing failed.",
    );
  }
  const logs = capture(["logs", "--timestamps", "--tail", "120", id]);
  report(`RabbitMQ recent stdout/stderr:\n${diagnosticResult(logs)}`);
  if (startup.error)
    report(
      `RabbitMQ startup command error: ${sanitizeRabbitMQDiagnostics(startup.error.message)}`,
    );
  return startup.status || 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const command = process.argv.slice(2);
  if (command[0] === "--") command.shift();
  process.exitCode = startRabbitMQ(command);
}
