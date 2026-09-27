import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  describeError,
  fetchWithRetry,
  isReadOnlyOperation,
} from "./browser-e2e-stack.mjs";

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/`,
      }),
    );
  });
}

test("a connection reset before any response is retried and then succeeds", async () => {
  let calls = 0;
  const { server, url } = await serve((req, res) => {
    calls += 1;
    if (calls === 1) {
      req.socket.destroy();
      return;
    }
    res.end("ok");
  });
  try {
    const response = await fetchWithRetry(url, { method: "POST", body: "x" });
    assert.equal(await response.text(), "ok");
    assert.equal(calls, 2);
  } finally {
    server.close();
  }
});

test("an HTTP error status is returned, never retried", async () => {
  let calls = 0;
  const { server, url } = await serve((_req, res) => {
    calls += 1;
    res.statusCode = 503;
    res.end("busy");
  });
  try {
    const response = await fetchWithRetry(url, { method: "POST", body: "x" });
    assert.equal(response.status, 503);
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test("a refused connection is not retried: the service is down, not stale", async () => {
  const { server, url } = await serve(() => undefined);
  server.close();
  await assert.rejects(fetchWithRetry(url, { method: "GET" }), TypeError);
});

test("retries stop after the attempt limit", async () => {
  let calls = 0;
  const { server, url } = await serve((req) => {
    calls += 1;
    req.socket.destroy();
  });
  try {
    await assert.rejects(
      fetchWithRetry(url, { method: "POST", body: "x" }, { attempts: 3 }),
      TypeError,
    );
    assert.equal(calls, 3);
  } finally {
    server.close();
  }
});

test("attempts: 1 sends the request exactly once, even after a reset", async () => {
  let calls = 0;
  const { server, url } = await serve((req) => {
    calls += 1;
    req.socket.destroy();
  });
  try {
    await assert.rejects(
      fetchWithRetry(url, { method: "POST", body: "x" }, { attempts: 1 }),
      TypeError,
    );
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test("only a provably read-only GraphQL document is retryable", () => {
  assert.equal(
    isReadOnlyOperation("query Q($id: ID!) { a(id: $id) { b } }"),
    true,
  );
  assert.equal(isReadOnlyOperation("  \n query Q { a }"), true);
  assert.equal(isReadOnlyOperation("{ a }"), true);
  assert.equal(isReadOnlyOperation("# note\nquery Q { a }"), true);
  assert.equal(isReadOnlyOperation("mutation M { a }"), false);
  assert.equal(
    isReadOnlyOperation("# leading comment\nmutation M { a }"),
    false,
  );
  assert.equal(
    isReadOnlyOperation("\n  # one\n  # two\n  mutation M { a }"),
    false,
  );
  assert.equal(isReadOnlyOperation("subscription S { a }"), false);
  assert.equal(
    isReadOnlyOperation("fragment F on T { a }\nmutation M { ...F }"),
    false,
  );
  assert.equal(isReadOnlyOperation(""), false);
  assert.equal(isReadOnlyOperation(undefined), false);
});

test("describeError includes the underlying cause code", () => {
  const cause = Object.assign(new Error("other side closed"), {
    code: "UND_ERR_SOCKET",
  });
  const error = new TypeError("fetch failed", { cause });
  const text = describeError(error);
  assert.match(text, /fetch failed/);
  assert.match(text, /UND_ERR_SOCKET/);
  assert.match(text, /other side closed/);
});
