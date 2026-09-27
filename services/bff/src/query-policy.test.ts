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
