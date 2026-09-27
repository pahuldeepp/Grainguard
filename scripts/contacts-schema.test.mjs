import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertAvroContract,
  registerAndValidateContactSchemas,
  validateRegisteredContactSchemas,
} from "./contacts-schema.mjs";

const contact = JSON.parse(
  readFileSync("contracts/events/notification-contacts-cdc.v1.avsc", "utf8"),
);
const heartbeat = JSON.parse(
  readFileSync(
    "contracts/events/notification-contacts-heartbeat.v2.avsc",
    "utf8",
  ),
);

test("checked-in Avro contracts match exactly and reject leaked or drifted fields", () => {
  assert.doesNotThrow(() => assertAvroContract(contact, contact));
  assert.doesNotThrow(() => assertAvroContract(heartbeat, heartbeat));
  assert.throws(() =>
    assertAvroContract(
      {
        ...contact,
        fields: [...contact.fields, { name: "updated_by", type: "string" }],
      },
      contact,
    ),
  );
  assert.throws(() =>
    assertAvroContract(
      {
        ...heartbeat,
        fields: heartbeat.fields.filter(
          ({ name }) => name !== "__source_ts_ms",
        ),
      },
      heartbeat,
    ),
  );
});

test("contract registration sets BACKWARD policy, checks existing schemas, and registers reviewed Avro", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (
      url.endsWith("/config/greenguard.notifications.contacts.cdc.v1-value") ||
      url.endsWith(
        "/config/greenguard.notifications.contacts.heartbeat.v2-value",
      )
    )
      return Response.json({ compatibility: "BACKWARD" });
    if (
      init.method === "GET" &&
      url.endsWith(
        "/subjects/greenguard.notifications.contacts.cdc.v1-value/versions",
      )
    )
      return Response.json([1]);
    if (
      init.method === "GET" &&
      url.endsWith(
        "/subjects/greenguard.notifications.contacts.heartbeat.v2-value/versions",
      )
    )
      return Response.json([]);
    if (url.includes("/compatibility/subjects/"))
      return Response.json({ is_compatible: true });
    if (url.endsWith("/versions")) return Response.json({ id: 17 });
    throw new Error(`unexpected registry request ${init.method} ${url}`);
  };
  const registered = await registerAndValidateContactSchemas(
    "http://registry.test",
    fakeFetch,
  );
  assert.deepEqual(
    registered.map(({ subject }) => subject),
    [
      "greenguard.notifications.contacts.cdc.v1-value",
      "greenguard.notifications.contacts.heartbeat.v2-value",
    ],
  );
  assert.equal(
    calls.filter(({ url }) => url.includes("/compatibility/")).length,
    1,
  );
  assert.equal(
    calls.filter(
      ({ url, init }) =>
        url.endsWith("/versions") &&
        init.method === "POST" &&
        init.body?.includes('"schemaType":"AVRO"'),
    ).length,
    2,
  );
  assert.ok(
    calls
      .filter(({ url }) => url.includes("/config/"))
      .every(({ init }) => JSON.parse(init.body).compatibility === "BACKWARD"),
  );
});

test("registered producer schemas must exactly match checked-in fields and BACKWARD policy", async () => {
  const schemas = new Map([
    ["greenguard.notifications.contacts.cdc.v1-value", contact],
    ["greenguard.notifications.contacts.heartbeat.v2-value", heartbeat],
  ]);
  const fakeFetch = async (url) => {
    const subject = [...schemas.keys()].find((candidate) =>
      url.includes(encodeURIComponent(candidate)),
    );
    if (!subject) throw new Error(`unexpected registry request ${url}`);
    if (url.includes("/versions/latest"))
      return Response.json({
        subject,
        schema: JSON.stringify(schemas.get(subject)),
      });
    return Response.json({ compatibility: "BACKWARD" });
  };
  await assert.doesNotReject(
    validateRegisteredContactSchemas("http://registry.test", fakeFetch),
  );
  schemas.set("greenguard.notifications.contacts.cdc.v1-value", {
    ...contact,
    fields: [...contact.fields, { name: "updated_by", type: "string" }],
  });
  await assert.rejects(
    validateRegisteredContactSchemas("http://registry.test", fakeFetch),
  );
});
