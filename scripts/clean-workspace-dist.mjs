import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);

for (const workspace of manifest.workspaces) {
  const output = resolve(root, workspace, "dist");
  if (output.startsWith(`${root}/`))
    rmSync(output, { recursive: true, force: true });
}
