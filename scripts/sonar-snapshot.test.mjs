import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSonarSnapshot } from "./sonar-snapshot.mjs";

test("worktree snapshot preserves current indexed sources and reports without private files", () => {
  const root = mkdtempSync(join(tmpdir(), "sonar-fixture-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  function git(cwd, ...args) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  }
  try {
    git(repo, "init");
    git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "user.name", "Fixture");
    writeFileSync(join(repo, "source.js"), "original");
    writeFileSync(join(repo, "removed.js"), "removed");
    git(repo, "add", "source.js", "removed.js");
    git(repo, "commit", "-m", "fixture");
    const normal = prepareSonarSnapshot(repo);
    assert.equal(normal.directory, repo);
    normal.cleanup();
    assert.ok(existsSync(repo));
    const worktree = join(root, "worktree");
    git(repo, "worktree", "add", "-b", "fixture-worktree", worktree);
    writeFileSync(join(worktree, "source.js"), "modified");
    writeFileSync(join(worktree, "added.js"), "added");
    git(worktree, "add", "added.js");
    git(worktree, "rm", "removed.js");
    writeFileSync(join(worktree, ".env"), "private");
    mkdirSync(join(worktree, "coverage"));
    writeFileSync(join(worktree, "coverage", "go.out"), "report");
    const snapshot = prepareSonarSnapshot(worktree, ["coverage/go.out"]);
    try {
      assert.ok(lstatSync(join(snapshot.directory, ".git")).isDirectory());
      assert.equal(
        readFileSync(join(snapshot.directory, "source.js"), "utf8"),
        "modified",
      );
      assert.equal(
        readFileSync(join(snapshot.directory, "coverage/go.out"), "utf8"),
        "report",
      );
      assert.equal(existsSync(join(snapshot.directory, ".env")), false);
      assert.equal(existsSync(join(snapshot.directory, "removed.js")), false);
      assert.match(git(snapshot.directory, "ls-files"), /added.js/);
      assert.equal(readFileSync(join(repo, "source.js"), "utf8"), "original");
    } finally {
      snapshot.cleanup();
    }
    assert.equal(existsSync(snapshot.directory), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exported source trees fail with a clear SCM error", () => {
  const root = mkdtempSync(join(tmpdir(), "sonar-export-"));
  try {
    assert.throws(() => prepareSonarSnapshot(root), /requires a Git checkout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
