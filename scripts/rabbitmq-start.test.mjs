import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeRabbitMQDiagnostics,
  startRabbitMQ,
} from "./rabbitmq-start.mjs";

const compose = [
  "docker",
  "compose",
  "--env-file",
  "isolated.env",
  "-f",
  "compose.yaml",
  "-f",
  "rabbitmq.yaml",
];
const id = "a".repeat(64);
function fixture(results) {
  const calls = [];
  const reports = [];
  return {
    calls,
    reports,
    run(command, args, options) {
      calls.push({ command, args, options });
      const result = results.shift();
      if (result instanceof Error) throw result;
      assert.ok(result, "unexpected additional command");
      return result;
    },
    report(value) {
      reports.push(value);
    },
  };
}
test("successful startup returns without reading container configuration or logs", () => {
  const fake = fixture([{ status: 0 }]);
  assert.equal(startRabbitMQ(compose, fake), 0);
  assert.deepEqual(fake.calls, [
    {
      command: "docker",
      args: [...compose.slice(1), "up", "-d", "--wait", "rabbitmq"],
      options: { stdio: "inherit" },
    },
  ]);
  assert.deepEqual(fake.reports, []);
});
test("failed startup captures selected state and bounded sanitized stdout/stderr before returning original status", () => {
  const fake = fixture([
    { status: 7 },
    { status: 0, stdout: `${id}\n` },
    {
      status: 0,
      stdout: JSON.stringify({
        Status: "exited",
        Running: false,
        ExitCode: 1,
        OOMKilled: false,
        Error: "token=secret-value",
        StartedAt: "start",
        FinishedAt: "finish",
        Health: { Status: "unhealthy", Log: [{ Output: "private-env" }] },
        Config: { Env: ["secret"] },
      }),
    },
    {
      status: 0,
      stdout: "startup phase\n",
      stderr:
        "BOOT FAILED password=private-value amqp://user:password@broker/vhost cookie=private-cookie",
    },
  ]);
  assert.equal(startRabbitMQ(compose, fake), 7);
  assert.deepEqual(
    fake.calls.map((call) => call.args),
    [
      [...compose.slice(1), "up", "-d", "--wait", "rabbitmq"],
      [...compose.slice(1), "ps", "--all", "--quiet", "rabbitmq"],
      ["inspect", "--format", "{{json .State}}", id],
      ["logs", "--timestamps", "--tail", "120", id],
    ],
  );
  for (const call of fake.calls.slice(1))
    assert.deepEqual(call.options, {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 256 * 1024,
    });
  const output = fake.reports.join("\n");
  assert.match(output, /"exitCode":1/);
  assert.match(output, /"oomKilled":false/);
  assert.match(output, /BOOT FAILED/);
  assert.match(output, /startup phase/);
  assert.doesNotMatch(
    output,
    /secret-value|private-value|private-cookie|user:password|private-env|"Config"|"Env"/,
  );
});
test("missing, ambiguous or malformed container identity preserves startup error without broad inspect", () => {
  for (const result of [
    { status: 1, stderr: "ps failed" },
    { status: 0, stdout: "" },
    { status: 0, stdout: `${id}\n${id}\n` },
    { status: 0, stdout: "not-a-container" },
    new Error("lookup failed token=private"),
  ]) {
    const fake = fixture([{ status: 2 }, result]);
    assert.equal(startRabbitMQ(compose, fake), 2);
    assert.equal(fake.calls.length, 2);
    assert.match(fake.reports[1], /identification unavailable/);
    assert.doesNotMatch(fake.reports.join("\n"), /private/);
  }
});
test("diagnostic parse, command errors and signals cannot mask original startup failure", () => {
  for (const inspected of [
    { status: 0, stdout: "invalid json" },
    { status: 1, stderr: "inspect failed" },
    new Error("inspect timed out"),
  ]) {
    const fake = fixture([
      { status: null, signal: "SIGKILL" },
      { status: 0, stdout: id },
      inspected,
      new Error("logs unavailable"),
    ]);
    assert.equal(startRabbitMQ(compose, fake), 1);
    assert.equal(fake.calls.length, 4);
    assert.match(fake.reports.join("\n"), /state unavailable/);
    assert.match(fake.reports.join("\n"), /logs unavailable/);
  }
  const fake = fixture([
    { status: null, error: new Error("docker not available") },
    { status: 1 },
  ]);
  assert.equal(startRabbitMQ(compose, fake), 1);
});
test("redaction covers connection URLs, assignments, quotes and bounded output", () => {
  const output = sanitizeRabbitMQDiagnostics(
    `password="value with spaces" token=plain cookie=hidden SECRET_KEY=abc RABBITMQ_DEFAULT_PASS=broker-pass 'cookie': 'json-cookie' https://user:pass@host/path?key=private postgres://user:pass@host/db`,
  );
  assert.doesNotMatch(
    output,
    /value with spaces|plain|hidden|abc|broker-pass|json-cookie|user:pass|private/,
  );
  assert.equal(sanitizeRabbitMQDiagnostics("X".repeat(100_000)).length, 24_000);
  assert.throws(
    () => startRabbitMQ(["sh", "-c", "docker compose"], fixture([])),
    /requires docker compose/,
  );
});

test("complete failure wrapper omits arbitrary State.Error before JSON serialization", () => {
  for (const secret of [
    'password="FAKE_STATE_SECRET with spaces"',
    'password="FAKE_STATE_SECRET with \\"escaped quote and remainder"',
    '{default_pass,<<"FAKE_STATE_SECRET">>}',
    "-setcookie FAKE_STATE_SECRET",
    "Authorization: Bearer FAKE_STATE_SECRET",
    "arbitrary FAKE_STATE_SECRET without a credential assignment",
  ]) {
    const fake = fixture([
      { status: 7 },
      { status: 0, stdout: id },
      {
        status: 0,
        stdout: JSON.stringify({
          Status: "exited",
          Error: secret,
          ExitCode: 1,
          OOMKilled: false,
        }),
      },
      { status: 0, stdout: "broker boot detail" },
    ]);
    assert.equal(startRabbitMQ(compose, fake), 7);
    const output = fake.reports.join("\n");
    assert.doesNotMatch(output, /FAKE_STATE_SECRET/);
    const state = JSON.parse(
      fake.reports
        .find((line) => line.startsWith("RabbitMQ container state:"))
        .split("state: ")[1],
    );
    assert.equal(state.error, "[redacted free-form container error]");
    assert.equal(state.exitCode, 1);
    assert.equal(state.oomKilled, false);
  }
});
test("complete wrapper omits quoted, escaped, Erlang, CLI and header credentials from each raw channel", () => {
  for (const secret of [
    'password="FAKE_RAW_SECRET with spaces"',
    'password="FAKE_RAW_SECRET with \\"escaped quote and remainder"',
    'password=\\"FAKE_RAW_SECRET with spaces\\"',
    '{default_pass,<<"FAKE_RAW_SECRET">>}',
    '{default_pass,<<"\nFAKE_RAW_SECRET\n">>}',
    "-setcookie FAKE_RAW_SECRET",
    "Authorization: Bearer FAKE_RAW_SECRET",
    "RABBITMQ_DEFAULT_PASS=FAKE_RAW_SECRET",
  ])
    for (const channel of ["stdout", "stderr"]) {
      const fake = fixture([
        { status: 9 },
        { status: 0, stdout: id },
        { status: 0, stdout: '{"Status":"exited"}' },
        { status: 0, [channel]: secret },
      ]);
      assert.equal(startRabbitMQ(compose, fake), 9);
      assert.doesNotMatch(fake.reports.join("\n"), /FAKE_RAW_SECRET/);
      assert.match(
        fake.reports.join("\n"),
        /redacted credential-bearing diagnostic output/,
      );
    }
});
