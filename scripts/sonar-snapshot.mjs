import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

function git(cwd, args, input) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", input });
  if (result.status !== 0)
    throw new Error("Unable to prepare Sonar Git source snapshot");
  return result.stdout;
}

export function prepareSonarSnapshot(cwd, reports = []) {
  if (!existsSync(join(cwd, ".git")))
    throw new Error("Sonar SCM analysis requires a Git checkout");
  if (lstatSync(join(cwd, ".git")).isDirectory())
    return { directory: cwd, cleanup() {} };
  const parent = mkdtempSync(join(tmpdir(), "greenguard-sonar-source-"));
  const directory = join(parent, "source");
  try {
    git(cwd, ["clone", "--no-hardlinks", "--no-tags", cwd, directory]);
    const current = git(cwd, ["ls-files", "-z"]).split("\0").filter(Boolean);
    const cloned = git(directory, ["ls-files", "-z"])
      .split("\0")
      .filter(Boolean);
    const currentSet = new Set(current);
    for (const file of cloned) {
      if (!currentSet.has(file) || !existsSync(join(cwd, file)))
        rmSync(join(directory, file), { force: true });
    }
    function copy(file) {
      const source = resolve(cwd, file);
      if (!source.startsWith(resolve(cwd) + sep))
        throw new Error("Sonar snapshot input escaped the repository");
      if (!existsSync(source)) return;
      const target = resolve(directory, file);
      mkdirSync(dirname(target), { recursive: true });
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) {
        if (existsSync(target)) rmSync(target);
        symlinkSync(readlinkSync(source), target);
      } else if (stat.isFile()) {
        copyFileSync(source, target);
      } else throw new Error("Sonar snapshot input must be a tracked file");
    }
    for (const file of current) copy(file);
    // Preserve additions/deletions in the current index without inventing a
    // commit or adding ignored local credentials to the analysis snapshot.
    git(
      directory,
      ["update-index", "--add", "--remove", "-z", "--stdin"],
      [...new Set([...cloned, ...current])].join("\0") + "\0",
    );
    for (const report of reports) copy(report);
    return {
      directory,
      cleanup: () => rmSync(parent, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
}
