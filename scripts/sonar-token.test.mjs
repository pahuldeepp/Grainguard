import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureAnalysisToken } from "./sonar-token.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "greenguard-sonar-token-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, ".env.sonar");
  writeFileSync(
    path,
    "SONAR_ADMIN_PASSWORD=private-admin\nSONAR_TOKEN=oldToken\nSONAR_TOKEN=olderToken\n",
  );
  return path;
}

test("a valid cached token is retained without generating another", async (t) => {
  const path = fixture(t);
  const original = readFileSync(path, "utf8");
  const token = await ensureAnalysisToken({
    host: "http://localhost:9000",
    token: "oldToken",
    path,
    generate: () => assert.fail("valid tokens must not rotate"),
    fetcher: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ valid: true }),
    }),
  });
  assert.equal(token, "oldToken");
  assert.equal(readFileSync(path, "utf8"), original);
});

test("a stale token is replaced once, preserving credentials and private mode", async (t) => {
  const path = fixture(t);
  let calls = 0;
  const token = await ensureAnalysisToken({
    host: "http://localhost:9000",
    token: "oldToken",
    path,
    generate: async () => "newToken",
    fetcher: async (url, options) => {
      assert.ok(
        [
          "http://localhost:9000/api/authentication/validate",
          "http://localhost:9000/api/settings/values?component=grainguard",
        ].includes(url),
      );
      const expected = calls++ === 0 ? "oldToken" : "newToken";
      assert.equal(
        options.headers.Authorization,
        "Basic " + Buffer.from(expected + ":").toString("base64"),
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({ valid: expected === "newToken" }),
      };
    },
  });
  assert.equal(token, "newToken");
  const content = readFileSync(path, "utf8");
  assert.equal(content.match(/^SONAR_TOKEN=/gm).length, 1);
  assert.ok(content.includes("SONAR_ADMIN_PASSWORD=private-admin"));
  assert.ok(content.includes("SONAR_TOKEN=newToken"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("server failures do not rotate credentials", async (t) => {
  const path = fixture(t);
  const original = readFileSync(path, "utf8");
  await assert.rejects(
    ensureAnalysisToken({
      host: "http://localhost:9000",
      token: "oldToken",
      path,
      generate: () => assert.fail("server failures must not trigger rotation"),
      fetcher: async () => ({ ok: false, status: 503 }),
    }),
    /HTTP 503/,
  );
  assert.equal(readFileSync(path, "utf8"), original);
});

test("an invalid replacement is not persisted", async (t) => {
  const path = fixture(t);
  const original = readFileSync(path, "utf8");
  await assert.rejects(
    ensureAnalysisToken({
      host: "http://localhost:9000",
      token: "oldToken",
      path,
      generate: async () => "newToken",
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ valid: false }),
      }),
    }),
    /failed validation/,
  );
  assert.equal(readFileSync(path, "utf8"), original);
});

test("a token scoped to another project is replaced", async (t) => {
  const path = fixture(t);
  let generated = 0;
  const token = await ensureAnalysisToken({
    host: "http://localhost:9000",
    token: "oldToken",
    path,
    generate: async () => {
      generated++;
      return "newToken";
    },
    fetcher: async (url, options) => {
      const old =
        options.headers.Authorization ===
        "Basic " + Buffer.from("oldToken:").toString("base64");
      return {
        ok: !(old && url.includes("/settings/")),
        status: old && url.includes("/settings/") ? 403 : 200,
        json: async () => ({ valid: true }),
      };
    },
  });
  assert.equal(token, "newToken");
  assert.equal(generated, 1);
});

test("rotation preserves an exported token assignment", async (t) => {
  const path = fixture(t);
  writeFileSync(
    path,
    "SONAR_ADMIN_PASSWORD=private-admin\nexport SONAR_TOKEN=oldToken\n",
  );
  let calls = 0;
  await ensureAnalysisToken({
    host: "http://localhost:9000",
    token: "oldToken",
    path,
    generate: async () => "newToken",
    fetcher: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ valid: calls++ > 0 }),
    }),
  });
  assert.ok(
    readFileSync(path, "utf8").includes("export SONAR_TOKEN=newToken\n"),
  );
});
