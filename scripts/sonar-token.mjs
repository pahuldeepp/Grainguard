import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

async function validToken(host, projectKey, token, fetcher) {
  if (!token) return false;
  const response = await fetcher(`${host}/api/authentication/validate`, {
    headers: {
      Authorization: "Basic " + Buffer.from(token + ":").toString("base64"),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401) return false;
  if (!response.ok)
    throw new Error(`Sonar token validation returned HTTP ${response.status}`);
  if ((await response.json()).valid !== true) return false;
  const project = await fetcher(
    `${host}/api/settings/values?component=${encodeURIComponent(projectKey)}`,
    {
      headers: {
        Authorization: "Basic " + Buffer.from(token + ":").toString("base64"),
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if ([401, 403, 404].includes(project.status)) return false;
  if (!project.ok)
    throw new Error(
      `Sonar project access check returned HTTP ${project.status}`,
    );
  return true;
}

export async function ensureAnalysisToken({
  host,
  projectKey = "grainguard",
  token,
  path,
  generate,
  fetcher = fetch,
}) {
  if (await validToken(host, projectKey, token, fetcher)) return token;
  const replacement = await generate();
  if (typeof replacement !== "string" || !/^[A-Za-z0-9_-]+$/.test(replacement))
    throw new Error("Sonar returned an invalid analysis token");
  if (!(await validToken(host, projectKey, replacement, fetcher)))
    throw new Error("New Sonar analysis token failed validation");
  const existing = readFileSync(path, "utf8");
  const prefix = existing
    .split("\n")
    .some((line) => /^\s*export\s+SONAR_TOKEN\s*=/.test(line))
    ? "export "
    : "";
  const retained = existing
    .split("\n")
    .filter((line) => !/^\s*(?:export\s+)?SONAR_TOKEN\s*=/.test(line))
    .join("\n")
    .replace(/\n*$/, "\n");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      retained + `${prefix}SONAR_TOKEN=${replacement}\n`,
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    renameSync(temporary, path);
  } catch (failure) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original write/rename failure if cleanup also fails.
    }
    throw failure;
  }
  return replacement;
}
