import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const contracts = [
  {
    topic: "greenguard.notifications.contacts.cdc.v1",
    file: "contracts/events/notification-contacts-cdc.v1.avsc",
  },
  {
    topic: "greenguard.notifications.contacts.heartbeat.v2",
    file: "contracts/events/notification-contacts-heartbeat.v2.avsc",
  },
];

export function avroShape(schema) {
  const parsed = typeof schema === "string" ? JSON.parse(schema) : schema;
  const fullname = parsed.namespace
    ? `${parsed.namespace}.${parsed.name}`
    : parsed.name;
  return {
    fullname,
    fields: parsed.fields.map((field) => ({
      name: field.name,
      type: simplifyType(field.type),
      ...(Object.hasOwn(field, "default") && { default: field.default }),
    })),
  };
}

function simplifyType(type) {
  if (Array.isArray(type)) return type.map(simplifyType);
  if (typeof type === "string") return type;
  if (!type || typeof type !== "object") throw new Error("invalid Avro type");
  if (typeof type.type === "string") return type.type;
  throw new Error("unsupported nested Avro type in contact CDC contract");
}

export function assertAvroContract(actual, expected) {
  assert.deepEqual(avroShape(actual), avroShape(expected));
}

async function registryRequest(
  baseUrl,
  path,
  method = "GET",
  body,
  fetcher = fetch,
) {
  const response = await fetcher(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/vnd.schemaregistry.v1+json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `Schema Registry ${method} ${path} failed (HTTP ${response.status})`,
    );
  return response.status === 204 ? undefined : response.json();
}

/** Register reviewed Avro contracts and prove the live Debezium subject uses them. */
export async function registerAndValidateContactSchemas(
  baseUrl = process.env.SCHEMA_REGISTRY_URL ?? "http://127.0.0.1:58081",
  fetcher = fetch,
) {
  const results = [];
  for (const item of contracts) {
    const schema = JSON.parse(readFileSync(item.file, "utf8"));
    const subject = `${item.topic}-value`;
    const encodedSubject = encodeURIComponent(subject);
    const policy = await registryRequest(
      baseUrl,
      `/config/${encodedSubject}`,
      "PUT",
      { compatibility: "BACKWARD" },
      fetcher,
    );
    assert.equal(
      policy.compatibility,
      "BACKWARD",
      `${subject} compatibility policy`,
    );

    const current = await registryRequest(
      baseUrl,
      `/subjects/${encodedSubject}/versions`,
      "GET",
      undefined,
      fetcher,
    ).catch((error) => {
      if (/HTTP 404/.test(error.message)) return [];
      throw error;
    });
    if (current.length > 0) {
      const compatibility = await registryRequest(
        baseUrl,
        `/compatibility/subjects/${encodedSubject}/versions/latest`,
        "POST",
        { schemaType: "AVRO", schema: JSON.stringify(schema) },
        fetcher,
      );
      assert.equal(
        compatibility.is_compatible,
        true,
        `${subject} BACKWARD compatibility`,
      );
    }

    const registered = await registryRequest(
      baseUrl,
      `/subjects/${encodedSubject}/versions`,
      "POST",
      { schemaType: "AVRO", schema: JSON.stringify(schema) },
      fetcher,
    );
    assert.ok(
      Number.isInteger(registered.id),
      `${subject} registered schema ID`,
    );
    results.push({ subject, id: registered.id });
  }
  return results;
}

export async function validateRegisteredContactSchemas(
  baseUrl = process.env.SCHEMA_REGISTRY_URL ?? "http://127.0.0.1:58081",
  fetcher = fetch,
) {
  for (const item of contracts) {
    const expected = JSON.parse(readFileSync(item.file, "utf8"));
    const subject = `${item.topic}-value`;
    const encodedSubject = encodeURIComponent(subject);
    const latest = await registryRequest(
      baseUrl,
      `/subjects/${encodedSubject}/versions/latest`,
      "GET",
      undefined,
      fetcher,
    );
    assertAvroContract(latest.schema, expected);
    const config = await registryRequest(
      baseUrl,
      `/config/${encodedSubject}`,
      "GET",
      undefined,
      fetcher,
    );
    assert.equal(
      config.compatibilityLevel ?? config.compatibility,
      "BACKWARD",
      `${subject} compatibility policy`,
    );
  }
}
