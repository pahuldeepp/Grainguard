import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  configureIsolatedControlPlaneLookup,
  createIsolatedMakefile,
} from "./stage12-compose-gate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("isolated lookup config sets both endpoint and generated token", () => {
  const env = configureIsolatedControlPlaneLookup(new Map(), "test-token");
  assert.equal(env.get("CONTROL_PLANE_URL"), "http://127.0.0.1:3010");
  assert.equal(env.get("CONTROL_LOOKUP_TOKEN"), "test-token");
});

test("all recursive make calls explicitly select the isolated Makefile", () => {
  const source = readFileSync(resolve(root, "Makefile"), "utf8");
  const project = "greenguard-stage12-static-test";
  const envPath = "/tmp/stage12-static-test/stage12.env";
  const generated = createIsolatedMakefile(source, {
    envPath,
    project,
    overlayPath: "/tmp/stage12-static-test/compose.override.yaml",
  });
  const recursiveLines = generated
    .split(/\r?\n/)
    .filter((line) => line.includes("$(MAKE)"));

  assert.ok(recursiveLines.length > 0, "expected recursive make targets");
  for (const line of recursiveLines) {
    assert.match(
      line,
      new RegExp(`\\$\\(MAKE\\) -f work/${project}/Makefile`),
      line,
    );
  }
  assert.ok(generated.includes(`-include ${envPath}`));
  assert.ok(!generated.includes("-include .env"));
  assert.match(
    generated,
    new RegExp(
      `^COMPOSE = docker compose --env-file ${envPath.replaceAll("/", "\\/")}`,
      "m",
    ),
  );
  assert.doesNotMatch(generated, /^COMPOSE = docker compose --env-file \.env/m);
});

test("recursive make loads the explicitly selected scratch Makefile", () => {
  const workRoot = resolve(root, "work");
  mkdirSync(workRoot, { recursive: true });
  const scratchDir = mkdtempSync(
    resolve(workRoot, "greenguard-stage12-recursion-test-"),
  );
  const project = basename(scratchDir);
  const relativeMakefile = `work/${project}/Makefile`;
  const absoluteMakefile = resolve(root, relativeMakefile);
  const fixtureDir = mkdtempSync(resolve(tmpdir(), "stage12-make-check-"));
  try {
    const fixture = [
      `-include ${resolve(fixtureDir, "private.env")}`,
      "$(info loaded=$(MAKEFILE_LIST))",
      ".PHONY: recurse child",
      "recurse:",
      `\t$(MAKE) -f ${relativeMakefile} --no-print-directory child`,
      "child:",
      "\t@echo child-from-isolated-makefile",
      "",
    ].join("\n");
    writeFileSync(absoluteMakefile, fixture, { mode: 0o600 });
    // MAKEFILE_LIST is exported by the parent product Makefile. With -e it
    // would override the scratch make's own list, hiding what it actually loads.
    const fixtureEnv = { ...process.env };
    delete fixtureEnv.MAKEFILE_LIST;
    const result = spawnSync("make", ["-f", relativeMakefile, "recurse"], {
      cwd: root,
      encoding: "utf8",
      env: fixtureEnv,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`loaded= ${relativeMakefile}`));
    assert.match(result.stdout, /child-from-isolated-makefile/);
    assert.ok(!result.stdout.includes(resolve(root, ".env")));
    assert.ok(!result.stderr.includes(resolve(root, ".env")));
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
