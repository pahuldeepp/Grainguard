import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

// Official 8.1 release ZIPs and their published .zip.sha256 files:
// https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/
export const VERSION = "8.1.0.6389";
const RELEASES = {
  darwin: [
    "macosx-aarch64",
    "20d12be4081896b337cd873d98ebd3d554be666086a45e31dd84a12ef51c3688",
  ],
  linux: [
    "linux-aarch64",
    "5e1c9328f4e261838de778c9e586ee608cca45ff7f0538108642219214628ba5",
  ],
};
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

export function nativeRelease(
  platform = process.platform,
  arch = process.arch,
) {
  if (arch !== "arm64" || !Object.hasOwn(RELEASES, platform))
    throw new Error("Native Sonar profile requires Linux or macOS ARM64");
  const [suffix, sha256] = RELEASES[platform];
  return {
    directory: `sonar-scanner-${VERSION}-${suffix}`,
    archive: `sonar-scanner-cli-${VERSION}-${suffix}.zip`,
    sha256,
  };
}

export function scannerProfile(value = "docker") {
  if (!["docker", "native"].includes(value))
    throw new Error("SONAR_SCANNER_PROFILE must be docker or native");
  return value;
}

async function ownedDirectory(path, privateMode = false) {
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    stat.mode & (privateMode ? 0o077 : 0o022)
  )
    throw new Error(
      "Sonar cache directory must be owned and protected by the current user",
    );
}

export async function verifyArchive(path, expected) {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid() ||
    stat.nlink !== 1 ||
    stat.mode & 0o077 ||
    stat.size > MAX_ARCHIVE_BYTES
  )
    throw new Error(
      "Sonar archive must be a private regular file owned by the current user",
    );
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("Sonar archive SHA-256 mismatch");
}

export async function downloadArchive(url, target, fetcher = fetch) {
  const response = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok || !response.body)
    throw new Error("Sonar archive download failed");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_ARCHIVE_BYTES)
      throw new Error("Sonar archive exceeds size limit");
    chunks.push(chunk);
  }
  await writeFile(target, Buffer.concat(chunks), { mode: 0o600, flag: "wx" });
}

// Each subprocess has its own process group. Deadlines and cancellation kill
// that group, including the separately launched scanner engine and Git children.
export function runBounded(
  command,
  args,
  {
    cwd,
    env = process.env,
    timeoutMs = 1_200_000,
    graceMs = 5_000,
    spawnProcess = spawn,
    kill = process.kill.bind(process),
    signals = process,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd,
      env,
      detached: true,
      stdio: "inherit",
    });
    let failure;
    let escalation;
    const send = (signal) => {
      if (!child.pid) return;
      try {
        kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH")
          failure = new Error("Unable to stop native Sonar subprocess group");
      }
    };
    const cleanup = () => {
      clearTimeout(deadline);
      signals.removeListener("SIGINT", onInterrupt);
      signals.removeListener("SIGTERM", onTerminate);
    };
    const stop = (reason) => {
      if (failure) return;
      failure = new Error(reason);
      send("SIGTERM");
      escalation = setTimeout(() => {
        send("SIGKILL");
        cleanup();
        reject(failure);
      }, graceMs);
    };
    const onInterrupt = () => stop("Native Sonar subprocess interrupted");
    const onTerminate = () => stop("Native Sonar subprocess terminated");
    signals.once("SIGINT", onInterrupt);
    signals.once("SIGTERM", onTerminate);
    const deadline = setTimeout(
      () => stop("Native Sonar subprocess timed out"),
      timeoutMs,
    );
    child.once("error", (error) => {
      cleanup();
      clearTimeout(escalation);
      reject(error);
    });
    child.once("close", (code) => {
      if (failure) return; // Keep the grace timer to reap surviving descendants.
      cleanup();
      resolve(code ?? 1);
    });
  });
}

// Python's ZIP reader validates the entire inventory before writing any entry.
// Official Linux releases contain relative legal-file links, made last so no
// archive entry can be written through a link.
export const EXTRACT_ZIP = String.raw`
import os, pathlib, shutil, stat, sys, zipfile
archive, destination, root_name = sys.argv[1:]
root = pathlib.Path(destination).resolve()
distribution = root / root_name
with zipfile.ZipFile(archive) as z:
    entries = z.infolist()
    if sum(i.file_size for i in entries) > 512 * 1024 * 1024:
        raise ValueError("Sonar archive expands beyond limit")
    seen, links = set(), {}
    for i in entries:
        name = i.filename.rstrip('/')
        parts = name.split('/')
        if not name or '\\' in name or any(p in ('', '.', '..') for p in parts) or parts[0] != root_name or name in seen:
            raise ValueError("Unsafe Sonar archive path")
        seen.add(name)
        mode = i.external_attr >> 16
        if stat.S_ISLNK(mode):
            if i.file_size > 4096: raise ValueError("Oversized Sonar archive link")
            target = z.read(i).decode('utf8')
            resolved = (root / name).parent.joinpath(target).resolve()
            if os.path.isabs(target) or '\\' in target or not resolved.is_relative_to(distribution):
                raise ValueError("Unsafe Sonar archive link")
            links[name] = target
        elif stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise ValueError("Unsupported Sonar archive entry")
    for name in seen:
        if any(str(p) in links for p in pathlib.PurePosixPath(name).parents):
            raise ValueError("Sonar archive entry traverses a link")
    for name, target in links.items():
        resolved = (root / name).parent.joinpath(target).resolve().relative_to(root)
        if str(resolved) not in seen or str(resolved) in links or any(str(p) in links for p in resolved.parents):
            raise ValueError("Sonar archive link must reference a regular entry")
    for i in entries:
        name = i.filename.rstrip('/')
        if name in links: continue
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if i.is_dir(): path.mkdir(exist_ok=True, mode=0o700)
        else:
            with z.open(i) as source, path.open('xb') as target: shutil.copyfileobj(source, target)
            path.chmod(0o700 if (i.external_attr >> 16) & 0o111 else 0o600)
    for name, target in links.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.symlink_to(target)
`;

export async function prepareNativeScanner({
  platform = process.platform,
  arch = process.arch,
  home = homedir(),
  download = downloadArchive,
  run = runBounded,
} = {}) {
  const release = nativeRelease(platform, arch);
  await ownedDirectory(home);
  const parent = join(home, ".cache");
  await ownedDirectory(parent);
  const cache = join(parent, "greenguard-sonar-scanner");
  await ownedDirectory(cache, true);
  const archive = join(cache, release.archive);
  try {
    await lstat(archive);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const temporary = join(cache, `${release.archive}.${randomUUID()}.partial`);
    try {
      await download(
        `https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/${release.archive}`,
        temporary,
      );
      await verifyArchive(temporary, release.sha256);
      await rename(temporary, archive);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await verifyArchive(archive, release.sha256);
  const directory = await mkdtemp(join(cache, "run-"));
  try {
    const code = await run(
      "python3",
      ["-c", EXTRACT_ZIP, archive, directory, release.directory],
      { timeoutMs: 120_000 },
    );
    if (code !== 0) throw new Error("Sonar archive extraction failed");
    const distribution = join(directory, release.directory);
    return {
      executable: join(distribution, "bin", "sonar-scanner"),
      java: join(distribution, "jre", "bin", "java"),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function runNativeScanner(
  cwd,
  env = process.env,
  { prepare = prepareNativeScanner, run = runBounded } = {},
) {
  const scanner = await prepare();
  try {
    return await run(
      scanner.executable,
      [
        "-Dsonar.scanner.skipJreProvisioning=true",
        `-Dsonar.scanner.javaExePath=${scanner.java}`,
      ],
      { cwd, env: { ...env, SONAR_HOST_URL: "http://127.0.0.1:9000" } },
    );
  } finally {
    await scanner.cleanup();
  }
}
