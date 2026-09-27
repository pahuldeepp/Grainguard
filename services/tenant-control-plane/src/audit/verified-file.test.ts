import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { NotFoundError } from "../domain/errors.js";
import { openVerifiedFile, sendVerified } from "./verified-file.js";

const dir = await mkdtemp(path.join(tmpdir(), "gg-verified-"));
after(() => rm(dir, { recursive: true, force: true }));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(name: string, text: string) {
  const file = path.join(dir, name);
  await writeFile(file, text);
  return file;
}
const collect = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
};

test("V01 a file whose SHA-256 matches opens and streams the same bytes", async () => {
  const file = await fixture("ok.jsonl", "row-1\nrow-2\n");
  const opened = await openVerifiedFile(file, sha("row-1\nrow-2\n"));
  assert.equal(opened.size, 12);
  assert.equal(await collect(opened.stream), "row-1\nrow-2\n");
});

test("V02 altered, truncated, missing or non-file targets are not found and reveal no path", async () => {
  const file = await fixture("bad.jsonl", "row-1\n");
  const expected = sha("row-1\n");
  await appendFile(file, "tampered\n");
  for (const target of [file, path.join(dir, "missing.jsonl"), dir]) {
    await assert.rejects(
      openVerifiedFile(target, expected),
      (e: unknown) =>
        e instanceof NotFoundError &&
        !String((e as Error).message).includes(dir),
    );
  }
  const truncated = await fixture("short.jsonl", "ro");
  await assert.rejects(openVerifiedFile(truncated, expected), NotFoundError);
});

test("V03 a file changed between hashing and sending is refused before any byte is sent", async () => {
  const file = await fixture("race.jsonl", "row-1\n");
  const opened = await openVerifiedFile(file, sha("row-1\n"));
  await appendFile(file, "late edit\n");
  const sink = Object.assign(new PassThrough(), { writeHead: () => sink });
  await assert.rejects(sendVerified(sink as never, opened, {}), NotFoundError);
  assert.equal(sink.readableLength, 0);
});

test("V04 a stream error mid-send destroys the response without throwing or leaking the path", async () => {
  const file = await fixture("mid.jsonl", "row-1\n");
  const opened = await openVerifiedFile(file, sha("row-1\n"));
  const failing = new Readable({
    read() {
      this.push("part");
      this.destroy(new Error(`EIO ${file}`));
    },
  });
  const sink = Object.assign(new PassThrough(), { writeHead: () => sink });
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    await sendVerified(
      sink as never,
      { ...opened, stream: failing },
      { "Content-Type": "text/plain" },
    );
  } finally {
    console.error = original;
  }
  assert.equal(sink.destroyed, true);
  assert.equal(JSON.stringify(logged).includes(dir), false);
});
