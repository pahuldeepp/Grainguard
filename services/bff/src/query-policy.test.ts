import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "graphql";
import {
  assertQueryBudget,
  operationHash,
  operations,
  persistedOperations,
  QueryPolicyError,
  resolvePersistedOperation,
} from "./query-policy.js";

const request = (query: string, extra: Record<string, unknown> = {}) => ({
  extensions: { persistedQuery: { sha256Hash: operationHash(query) } },
  ...extra,
});

test("only registered, untampered persisted operations execute", () => {
  const accepted = resolvePersistedOperation(
    request(operations.provisioningStatus, { variables: { id: "s1" } }),
  );
  assert.equal(accepted.query, operations.provisioningStatus);
  assert.equal(accepted.extensions, undefined);
  assert.throws(
    () => resolvePersistedOperation({ query: operations.provisioningStatus }),
    { code: "persisted_operation_required" },
  );
  assert.throws(
    () => resolvePersistedOperation(request("query Unknown { __typename }")),
    { code: "operation_not_allowed" },
  );
  assert.throws(
    () =>
      resolvePersistedOperation(
        request(operations.provisioningStatus, {
          query: "mutation { __typename }",
        }),
      ),
    { code: "operation_hash_mismatch" },
  );
  assert.equal(persistedOperations.size, Object.keys(operations).length);
});

test("cost gate bounds aliases, nesting, fragments, and operation count", () => {
  assert.doesNotThrow(() =>
    assertQueryBudget(parse(operations.provisioningStatus)),
  );
  const aliases = Array.from(
    { length: 41 },
    (_, i) => `a${i}: __typename`,
  ).join(" ");
  assert.throws(() => assertQueryBudget(parse(`query A { ${aliases} }`)), {
    code: "query_budget_exceeded",
  });
  assert.throws(
    () =>
      assertQueryBudget(
        parse("query A { a { b { c { d { e { f { g } } } } } } }"),
      ),
    { code: "query_budget_exceeded" },
  );
  assert.throws(
    () =>
      assertQueryBudget(
        parse("query A { ...F } fragment F on Query { __typename }"),
      ),
    { code: "fragments_not_allowed" },
  );
  assert.throws(
    () =>
      assertQueryBudget(parse("query A { __typename } query B { __typename }")),
    { code: "single_operation_required" },
  );
  assert.ok(new QueryPolicyError("x") instanceof Error);
});

test("all shipped operation documents fit the resolver budget and new hashes stay pinned", () => {
  for (const query of Object.values(operations))
    assertQueryBudget(parse(query));
  const expected = {
    alertListV2:
      "396838eb74e8646aaa0eff147eaf1ec7c828709e47d506fe13206a5b643c5da3",
    alertDetailV2:
      "3c25254d5a8578cffe28243acb7244b7c072fe40adcc553e65c3cbc48290e2ae",
    alertHistory:
      "9b48101f81e7442fca153c8874c1e73f32ec2c76779632ad7a2939faba1472cb",
    alertNotifications:
      "1d698e8f7d31fa9b524760cb838ce5ae159bf319e814348ed79036a6b03b7142",
    binReadingsLatest:
      "b35aaa22693c18efc93bc6d2168857359db82bdae192c6451f6bcfe5e81eb34f",
    binReadingsTrend:
      "64558554c608931cc737d50a31b9d70c6be2564974d21c0009b3c31ff62b3a6d",
  };
  for (const [name, hash] of Object.entries(expected))
    assert.equal(
      operationHash(operations[name as keyof typeof operations]),
      hash,
      `${name} exact bytes changed`,
    );
});
