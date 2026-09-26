import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderAwsConfig } from "./render-observability-aws-config.mjs";

const template = await readFile(
  new URL("../infra/observability/aws-cloudwatch.yaml", import.meta.url),
  "utf8",
);

test("renders region and explicit bounded AWS allowlists", () => {
  const output = renderAwsConfig(template, {
    region: "ca-central-1",
    lambdaFunctions: "device-api, telemetry-worker",
    dynamodbTables: "greenguard-devices, greenguard-events",
  });
  assert.match(output, /^region: ca-central-1$/m);
  assert.equal(
    (output.match(/FunctionName: \["device-api", "telemetry-worker"\]/g) ?? [])
      .length,
    4,
  );
  assert.match(output, /function_name: \["device-api", "telemetry-worker"\]/);
  assert.equal(
    (
      output.match(
        /TableName: \["greenguard-devices", "greenguard-events"\]/g,
      ) ?? []
    ).length,
    4,
  );
  assert.doesNotMatch(output, /allowlist-required/);
});

test("rejects empty allowlists and unsafe names", () => {
  assert.throws(
    () =>
      renderAwsConfig(template, {
        region: "us-east-1",
        lambdaFunctions: "",
        dynamodbTables: "events",
      }),
    /AWS_LAMBDA_FUNCTIONS must contain/,
  );
  assert.throws(
    () =>
      renderAwsConfig(template, {
        region: "us-east-1",
        lambdaFunctions: "lambda]\\ninjected: true",
        dynamodbTables: "events",
      }),
    /invalid name/,
  );
});
