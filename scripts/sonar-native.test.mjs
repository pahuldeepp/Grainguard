import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  mkdir,
  chmod,
  symlink,
  rm,
  readdir,
  readFile,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeRelease,
  scannerProfile,
  scannerHome,
  verifyArchive,
  downloadArchive,
  prepareNativeScanner,
  runNativeScanner,
  runBounded,
  EXTRACT_ZIP,
} from "./sonar-native.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "sonar-native-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("native scanner honors a job-private home while preserving the user-home default", () => {
  assert.equal(
    scannerHome({ SONAR_SCANNER_HOME: "/runner/temp/sonar-home" }, "/home/runner"),
    "/runner/temp/sonar-home",
  );
  assert.equal(scannerHome({}, "/home/runner"), "/home/runner");
});

test("native releases are pinned and profile selection is explicit", () => {
  assert.equal(scannerProfile(), "docker");
  assert.equal(scannerProfile("native"), "native");
  assert.throws(() => scannerProfile("other"));
  assert.equal(
    nativeRelease("darwin", "arm64").sha256,
    "20d12be4081896b337cd873d98ebd3d554be666086a45e31dd84a12ef51c3688",
  );
  assert.equal(
    nativeRelease("linux", "arm64").sha256,
    "5e1c9328f4e261838de778c9e586ee608cca45ff7f0538108642219214628ba5",
  );
  assert.match(
    nativeRelease("linux", "arm64").archive,
    /8\.1\.0\.6389-linux-aarch64.zip$/,
  );
  for (const [platform, arch] of [
    ["linux", "x64"],
    ["darwin", "x64"],
    ["win32", "arm64"],
    ["toString", "arm64"],
  ])
    assert.throws(() => nativeRelease(platform, arch));
});

test("archive hash, file mode, and symlink checks fail closed", async (t) => {
  const home = await fixture(t);
  const archive = join(home, "archive.zip");
  const digest = createHash("sha256").update("fixture").digest("hex");
  await writeFile(archive, "fixture", { mode: 0o600 });
  await verifyArchive(archive, digest);
  await assert.rejects(verifyArchive(archive, "0".repeat(64)), /SHA-256/);
  await chmod(archive, 0o644);
  await assert.rejects(verifyArchive(archive, digest), /private regular/);
  await chmod(archive, 0o600);
  const link = join(home, "link.zip");
  await symlink(archive, link);
  await assert.rejects(verifyArchive(link, digest), /private regular/);
});

test("downloads are bounded, refuse redirects, and write private files", async (t) => {
  const home = await fixture(t);
  const target = join(home, "archive");
  await downloadArchive(
    "https://fixture.invalid",
    target,
    async (url, options) => {
      assert.equal(url, "https://fixture.invalid");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return new Response("fixture");
    },
  );
  assert.equal(await readFile(target, "utf8"), "fixture");
  assert.equal((await lstat(target)).mode & 0o777, 0o600);
  await assert.rejects(
    downloadArchive("x", target, async () => new Response("", { status: 403 })),
    /download failed/,
  );
  await assert.rejects(
    downloadArchive("x", target, async () => ({
      ok: true,
      body: [Buffer.alloc(100 * 1024 * 1024 + 1)],
    })),
    /size limit/,
  );
});

test("tampered downloads never extract and temporary files are removed", async (t) => {
  const home = await fixture(t);
  let ran = false;
  await assert.rejects(
    prepareNativeScanner({
      home,
      platform: "darwin",
      arch: "arm64",
      download: async (url, target) => {
        assert.equal(
          url,
          "https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-8.1.0.6389-macosx-aarch64.zip",
        );
        await writeFile(target, "tampered", { mode: 0o600 });
      },
      run: async () => {
        ran = true;
      },
    }),
    /SHA-256/,
  );
  assert.equal(ran, false);
  assert.deepEqual(
    await readdir(join(home, ".cache", "greenguard-sonar-scanner")),
    [],
  );
});

test("unsafe cache directories and cached archives are rejected before execution", async (t) => {
  const home = await fixture(t);
  const cacheParent = join(home, ".cache");
  const elsewhere = join(home, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, cacheParent);
  await assert.rejects(
    prepareNativeScanner({ home, platform: "linux", arch: "arm64" }),
    /owned and protected/,
  );
  await rm(cacheParent);
  const cache = join(cacheParent, "greenguard-sonar-scanner");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await chmod(cache, 0o755);
  await assert.rejects(
    prepareNativeScanner({ home, platform: "linux", arch: "arm64" }),
    /owned and protected/,
  );
  await chmod(cache, 0o700);
  await writeFile(
    join(cache, nativeRelease("linux", "arm64").archive),
    "tampered",
    { mode: 0o600 },
  );
  await assert.rejects(
    prepareNativeScanner({
      home,
      platform: "linux",
      arch: "arm64",
      download: () => assert.fail("must not redownload cached untrusted file"),
      run: () => assert.fail("must not execute"),
    }),
    /SHA-256/,
  );
});

async function extractFixture(t, entries) {
  const home = await fixture(t);
  const archive = join(home, "fixture.zip");
  const output = join(home, "output");
  await mkdir(output);
  const create = spawnSync(
    "python3",
    [
      "-c",
      String.raw`
import json, stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for name, content, mode in json.loads(sys.argv[2]):
        i = zipfile.ZipInfo(name)
        i.external_attr = mode << 16
        z.writestr(i, content)
`,
      archive,
      JSON.stringify(entries),
    ],
    { encoding: "utf8" },
  );
  assert.equal(create.status, 0, create.stderr);
  const result = spawnSync(
    "python3",
    ["-c", EXTRACT_ZIP, archive, output, "scanner"],
    { encoding: "utf8", timeout: 5000 },
  );
  return { result, output };
}

test("extractor permits regular files and contained legal-file links", async (t) => {
  const { result, output } = await extractFixture(t, [
    ["scanner/bin/java", "executable", 0o100755],
    ["scanner/legal/java.base/LICENSE", "license", 0o100644],
    ["scanner/legal/other/LICENSE", "../java.base/LICENSE", 0o120777],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    (await lstat(join(output, "scanner/bin/java"))).mode & 0o777,
    0o700,
  );
  assert.equal(
    await readFile(join(output, "scanner/legal/other/LICENSE"), "utf8"),
    "license",
  );
});

for (const entries of [
  [["../outside", "bad", 0o100644]],
  [["/scanner/file", "bad", 0o100644]],
  [["scanner/../outside", "bad", 0o100644]],
  [["scanner\\outside", "bad", 0o100644]],
  [["scanner/link", "../../outside", 0o120777]],
  [["scanner/link", "/tmp/outside", 0o120777]],
  [
    ["scanner/link", "target", 0o120777],
    ["scanner/link/file", "bad", 0o100644],
  ],
  [
    ["scanner/file", "first", 0o100644],
    ["scanner/file", "duplicate", 0o100644],
  ],
])
  test(`extractor rejects unsafe inventory ${JSON.stringify(entries)}`, async (t) => {
    const { result, output } = await extractFixture(t, entries);
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readdir(output), []);
  });

test("native invocation preserves snapshot and returns gate failure; token stays in environment", async () => {
  let cleaned = 0;
  const code = await runNativeScanner(
    "/snapshot",
    { SONAR_TOKEN: "test-token", PATH: "/bin" },
    {
      prepare: async () => ({
        executable: "/pinned/scanner",
        java: "/pinned/java",
        cleanup: async () => cleaned++,
      }),
      run: async (command, args, options) => {
        assert.equal(command, "/pinned/scanner");
        assert.deepEqual(args, [
          "-Dsonar.scanner.skipJreProvisioning=true",
          "-Dsonar.scanner.javaExePath=/pinned/java",
        ]);
        assert.equal(options.cwd, "/snapshot");
        assert.equal(options.env.SONAR_TOKEN, "test-token");
        assert.equal(options.env.SONAR_HOST_URL, "http://127.0.0.1:9000");
        return 2;
      },
    },
  );
  assert.equal(code, 2);
  assert.equal(cleaned, 1);
  await assert.rejects(
    runNativeScanner(
      "/snapshot",
      {},
      {
        prepare: async () => ({ cleanup: async () => cleaned++ }),
        run: async () => {
          throw new Error("timeout");
        },
      },
    ),
    /timeout/,
  );
  assert.equal(cleaned, 2);
});

test("bounded child preserves nonzero and signal exits", async () => {
  for (const code of [0, 2, null]) {
    const child = new EventEmitter();
    const signals = new EventEmitter();
    const result = runBounded("scanner", [], {
      signals,
      spawnProcess: (command, args, options) => {
        assert.equal(options.detached, true);
        queueMicrotask(() => child.emit("close", code));
        return child;
      },
    });
    assert.equal(await result, code ?? 1);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  }
});

test("timeout kills only the owned group even if its leader exits early", async () => {
  const child = new EventEmitter();
  child.pid = 12345;
  const sent = [];
  await assert.rejects(
    runBounded("scanner", [], {
      signals: new EventEmitter(),
      timeoutMs: 5,
      graceMs: 5,
      spawnProcess: () => child,
      kill: (pid, signal) => {
        sent.push([pid, signal]);
        child.emit("close", 143);
      },
    }),
    /timed out/,
  );
  assert.deepEqual(sent, [
    [-12345, "SIGTERM"],
    [-12345, "SIGKILL"],
  ]);
});

test("parent cancellation terminates descendants and missing processes are harmless", async () => {
  const child = new EventEmitter();
  child.pid = 54321;
  const signals = new EventEmitter();
  const result = runBounded("scanner", [], {
    signals,
    graceMs: 5,
    spawnProcess: () => child,
    kill: (pid) => {
      assert.equal(pid, -54321);
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
  });
  signals.emit("SIGTERM");
  await assert.rejects(result, /terminated/);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("spawn errors reject and unregister cancellation handlers", async () => {
  const signals = new EventEmitter();
  const child = new EventEmitter();
  const result = runBounded("scanner", [], {
    signals,
    spawnProcess: () => {
      queueMicrotask(() => child.emit("error", new Error("missing runtime")));
      return child;
    },
  });
  await assert.rejects(result, /missing runtime/);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("signal permission failures reject within the deadline", async () => {
  const child = new EventEmitter();
  child.pid = 54321;
  await assert.rejects(
    runBounded("scanner", [], {
      signals: new EventEmitter(),
      timeoutMs: 5,
      graceMs: 5,
      spawnProcess: () => child,
      kill: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    }),
    /Unable to stop/,
  );
});
