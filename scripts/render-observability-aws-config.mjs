import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = resolve(ROOT, "infra/observability/aws-cloudwatch.yaml");
const OUTPUT = resolve(
  ROOT,
  "infra/observability/.generated/aws-cloudwatch.yaml",
);

function parseAllowlist(value, name, pattern) {
  const entries = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  if (entries.length === 0)
    throw new Error(`${name} must contain at least one comma-separated name`);
  for (const entry of entries) {
    if (!pattern.test(entry))
      throw new Error(`${name} contains an invalid name: ${entry}`);
  }
  return entries;
}

function yamlList(entries) {
  return `[${entries.map((entry) => JSON.stringify(entry)).join(", ")}]`;
}

export function renderAwsConfig(
  template,
  { region, lambdaFunctions, dynamodbTables },
) {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region ?? "")) {
    throw new Error("AWS_REGION must be a valid AWS region name");
  }
  const lambdas = parseAllowlist(
    lambdaFunctions,
    "AWS_LAMBDA_FUNCTIONS",
    /^[A-Za-z0-9_-]{1,64}$/,
  );
  const tables = parseAllowlist(
    dynamodbTables,
    "AWS_DYNAMODB_TABLES",
    /^[A-Za-z0-9_.-]{3,255}$/,
  );
  return template
    .replace(/^region:.*$/m, `region: ${region}`)
    .replaceAll("[greenguard-lambda-allowlist-required]", yamlList(lambdas))
    .replaceAll("[greenguard-dynamodb-allowlist-required]", yamlList(tables));
}

async function main(env = process.env) {
  const template = await readFile(TEMPLATE, "utf8");
  const config = renderAwsConfig(template, {
    region: env.AWS_REGION ?? "us-east-1",
    lambdaFunctions: env.AWS_LAMBDA_FUNCTIONS,
    dynamodbTables: env.AWS_DYNAMODB_TABLES,
  });
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, config, { mode: 0o600 });
  console.log(`Wrote allowlisted CloudWatch exporter config to ${OUTPUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
