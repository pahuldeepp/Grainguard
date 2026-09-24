import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_REGISTRY,
  loadVersionRegistry,
  resolveVersion,
  type VersionRegistry,
} from "./index.js";

const load = (value: unknown) =>
  loadVersionRegistry({ API_VERSION_POLICY: JSON.stringify(value) });

test("absent env yields the default registry", () => {
  assert.equal(loadVersionRegistry({}), DEFAULT_REGISTRY);
  assert.equal(DEFAULT_REGISTRY.defaultVersion, "1");
});

test("loads ISO dates, successor and documentation", () => {
  const registry = load({
    defaultVersion: "2",
    versions: [
      {
        version: "1",
        deprecatedAt: "2026-01-01T00:00:00Z",
        sunsetAt: "2026-06-01T00:00:00Z",
        successor: "2",
        documentationUrl: "https://docs.example.com/v1",
      },
      { version: "2" },
    ],
  });
  assert.equal(registry.defaultVersion, "2");
  assert.equal(
    registry.versions[0]?.deprecatedAt?.toISOString(),
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(
    registry.versions[0]?.sunsetAt?.toISOString(),
    "2026-06-01T00:00:00.000Z",
  );
  assert.equal(registry.versions[0]?.successor, "2");
  assert.equal(
    registry.versions[0]?.documentationUrl,
    "https://docs.example.com/v1",
  );
  assert.deepEqual(registry.versions[1], { version: "2" });
});

test("equal deprecatedAt and sunsetAt is accepted", () => {
  const at = "2026-01-01T00:00:00Z";
  assert.equal(
    load({
      defaultVersion: "1",
      versions: [{ version: "1", deprecatedAt: at, sunsetAt: at }],
    }).versions.length,
    1,
  );
});

const rejections: Array<[string, NodeJS.ProcessEnv, RegExp]> = [
  ["invalid JSON", { API_VERSION_POLICY: "{nope" }, /not valid JSON/],
  ["null document", { API_VERSION_POLICY: "null" }, /must contain/],
  [
    "missing versions",
    { API_VERSION_POLICY: '{"defaultVersion":"1"}' },
    /must contain/,
  ],
  [
    "non-string default",
    { API_VERSION_POLICY: '{"defaultVersion":1,"versions":[]}' },
    /must contain/,
  ],
  [
    "non-object entry",
    { API_VERSION_POLICY: '{"defaultVersion":"1","versions":[5]}' },
    /valid "version"/,
  ],
  [
    "bad version chars",
    {
      API_VERSION_POLICY:
        '{"defaultVersion":"1","versions":[{"version":"a b"}]}',
    },
    /valid "version"/,
  ],
  [
    "unknown default",
    {
      API_VERSION_POLICY: '{"defaultVersion":"9","versions":[{"version":"1"}]}',
    },
    /defaultVersion "9"/,
  ],
  [
    "duplicate",
    {
      API_VERSION_POLICY:
        '{"defaultVersion":"1","versions":[{"version":"1"},{"version":"1"}]}',
    },
    /duplicate version "1"/,
  ],
  [
    "unparsable date",
    {
      API_VERSION_POLICY:
        '{"defaultVersion":"1","versions":[{"version":"1","sunsetAt":"soon"}]}',
    },
    /invalid sunsetAt/,
  ],
  [
    "non-string date",
    {
      API_VERSION_POLICY:
        '{"defaultVersion":"1","versions":[{"version":"1","deprecatedAt":5}]}',
    },
    /invalid deprecatedAt/,
  ],
  [
    "sunset before deprecation",
    {
      API_VERSION_POLICY:
        '{"defaultVersion":"1","versions":[{"version":"1","deprecatedAt":"2026-02-01T00:00:00Z","sunsetAt":"2026-01-01T00:00:00Z"}]}',
    },
    /earlier than deprecatedAt/,
  ],
  [
    "unknown successor",
    {
      API_VERSION_POLICY:
        '{"defaultVersion":"1","versions":[{"version":"1","successor":"7"}]}',
    },
    /successor "7"/,
  ],
  [
    "empty successor",
    {
      API_VERSION_POLICY:
        '{"defaultVersion":"1","versions":[{"version":"1","successor":""}]}',
    },
    /invalid successor/,
  ],
  [
    "non-string docs",
    {
      API_VERSION_POLICY:
        '{"defaultVersion":"1","versions":[{"version":"1","documentationUrl":3}]}',
    },
    /invalid documentationUrl/,
  ],
];
for (const [name, env, pattern] of rejections) {
  test(`loadVersionRegistry rejects ${name}`, () => {
    assert.throws(() => loadVersionRegistry(env), pattern);
  });
}

const registry: VersionRegistry = {
  defaultVersion: "1",
  versions: [
    {
      version: "1",
      deprecatedAt: new Date("2026-01-01T00:00:00Z"),
      sunsetAt: new Date("2026-06-01T00:00:00Z"),
    },
    { version: "2", deprecatedAt: new Date("2026-03-01T00:00:00Z") },
    { version: "3", sunsetAt: new Date("2027-01-01T00:00:00Z") },
    { version: "4" },
  ],
};

test("resolveVersion states around boundaries", () => {
  const state = (h: string | undefined, iso: string) => {
    const r = resolveVersion(h, registry, new Date(iso));
    return r.kind === "ok" ? r.resolved.state : r.kind;
  };
  assert.equal(state(undefined, "2025-12-31T23:59:59Z"), "deprecated");
  assert.equal(state("1", "2026-01-01T00:00:00Z"), "deprecated");
  assert.equal(state("1", "2026-05-31T23:59:59Z"), "deprecated");
  assert.equal(state("1", "2026-06-01T00:00:00Z"), "sunset");
  assert.equal(state(" 2 ", "2026-02-01T00:00:00Z"), "current");
  assert.equal(state("2", "2026-03-01T00:00:00Z"), "deprecated");
  assert.equal(state("3", "2026-01-01T00:00:00Z"), "deprecated");
  assert.equal(state("4", "2030-01-01T00:00:00Z"), "current");
  assert.equal(state("9", "2026-01-01T00:00:00Z"), "unsupported");
});

test("resolveVersion truncates the requested value", () => {
  const r = resolveVersion(` ${"x".repeat(100)} `, registry, new Date());
  assert.deepEqual(r, { kind: "unsupported", requested: "x".repeat(64) });
});
