import { createHash } from "node:crypto";
import { isUuid } from "../db/tenant.js";
import { InvalidInputError } from "../inventory/errors.js";

const ENTITY_NAMESPACE = "409d1c3b-a7ed-5fc4-830f-20373fb7e663";
const EVENT_NAMESPACE = "a00f2290-bf1c-5eb9-b19a-54f3acb29355";
const IDENTIFIER = /^[A-Za-z\d][\w.:-]{0,127}$/;
const TOPIC = /^[A-Za-z\d][\w.:-]{0,511}$/;
const OFFSET = /^(0|[1-9]\d{0,18})$/;
const SHA256 = /^[\da-f]{64}$/;
const MAX_OFFSET = 9223372036854775807n;
const FIELDS = [
  "contract_version",
  "event_id",
  "source_id",
  "source_coordinate",
  "tenant_id",
  "entity_type",
  "external_id",
  "entity_id",
  "operation",
  "payload",
  "payload_sha256",
];

export type ImportEntity = "site" | "bin" | "device";
export interface ImportChange {
  contract_version: 1;
  event_id: string;
  source_id: string;
  source_coordinate: {
    connector_generation: string;
    topic: string;
    partition: number;
    offset: string;
  };
  tenant_id: string;
  entity_type: ImportEntity;
  external_id: string;
  entity_id: string;
  operation: "upsert" | "delete";
  payload: Record<string, string | null>;
  payload_sha256: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidInputError("import change must be an object");
  return value as Record<string, unknown>;
}
function exact(record: Record<string, unknown>, keys: string[]): void {
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record))
  )
    throw new InvalidInputError(
      "import change fields do not match v1 contract",
    );
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}
function topic(value: unknown): value is string {
  return typeof value === "string" && TOPIC.test(value);
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    [...value].length >= 1 &&
    [...value].length <= max &&
    !value.startsWith(" ") &&
    !value.endsWith(" ") &&
    ![...value].some((char) => {
      const point = char.codePointAt(0)!;
      return point < 32 || (point >= 127 && point <= 159);
    })
  );
}

// Python uuid.uuid5(namespace, json.dumps(parts, separators=(",", ":")))
export function stableUuid(
  namespace: string,
  parts: (string | number | bigint)[],
): string {
  const encoded = `[${parts.map(encodeUuidPart).join(",")}]`;
  // UUIDv5 is defined with SHA-1. These are deterministic identifiers, not
  // authentication tokens or integrity/signature digests; changing this breaks
  // persisted IDs shared with the MySQL normalizer.
  const digest = createHash("sha1") // NOSONAR - UUIDv5 mandates SHA-1; this is identity derivation, not security hashing.
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(encoded)
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const h = digest.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function encodeUuidPart(part: string | number | bigint): string {
  if (typeof part === "bigint") return part.toString();
  return JSON.stringify(part);
}
export function canonicalId(
  source: string,
  tenant: string,
  entity: ImportEntity,
  external: string,
): string {
  return stableUuid(ENTITY_NAMESPACE, [source, tenant, entity, external]);
}

function expectedPayloadKeys(entity: ImportEntity): string[] {
  const idName = `${entity}_id`;
  switch (entity) {
    case "site":
      return [idName, "name"];
    case "bin":
      return [idName, "site_id", "name"];
    case "device":
      return [idName, "site_id", "bin_id", "serial_number", "status"];
  }
}

export function parseImportChange(
  value: unknown,
  tenantId: string,
): ImportChange {
  const raw = object(value);
  exact(raw, FIELDS);
  const entity = validateImportIdentity(raw, tenantId);
  const coordinate = validateCoordinate(raw.source_coordinate);
  validateSourceIdentity(raw, tenantId, entity, coordinate);
  validatePayload(raw, entity);
  return raw as unknown as ImportChange;
}

function validateImportIdentity(
  raw: Record<string, unknown>,
  tenantId: string,
): ImportEntity {
  if (
    raw.contract_version !== 1 ||
    !identifier(raw.source_id) ||
    !identifier(raw.external_id) ||
    typeof raw.tenant_id !== "string" ||
    !isUuid(raw.tenant_id) ||
    raw.tenant_id !== tenantId ||
    (raw.entity_type !== "site" &&
      raw.entity_type !== "bin" &&
      raw.entity_type !== "device") ||
    (raw.operation !== "upsert" && raw.operation !== "delete") ||
    typeof raw.payload_sha256 !== "string" ||
    !SHA256.test(raw.payload_sha256)
  )
    throw new InvalidInputError("invalid import identity or version");
  return raw.entity_type as ImportEntity;
}

function validateCoordinate(value: unknown): Record<string, unknown> {
  const coordinate = object(value);
  exact(coordinate, ["connector_generation", "topic", "partition", "offset"]);
  if (
    !identifier(coordinate.connector_generation) ||
    !topic(coordinate.topic) ||
    !Number.isSafeInteger(coordinate.partition) ||
    (coordinate.partition as number) < 0 ||
    typeof coordinate.offset !== "string" ||
    !OFFSET.test(coordinate.offset) ||
    BigInt(coordinate.offset) > MAX_OFFSET
  )
    throw new InvalidInputError("invalid source coordinate");
  return coordinate;
}

function validateSourceIdentity(
  raw: Record<string, unknown>,
  tenantId: string,
  entity: ImportEntity,
  coordinate: Record<string, unknown>,
): void {
  if (
    raw.entity_id !==
    canonicalId(
      raw.source_id as string,
      tenantId,
      entity,
      raw.external_id as string,
    )
  )
    throw new InvalidInputError(
      "canonical entity ID does not match source identity",
    );
  if (
    typeof raw.event_id !== "string" ||
    !isUuid(raw.event_id) ||
    raw.event_id !==
      stableUuid(EVENT_NAMESPACE, [
        raw.source_id as string,
        coordinate.connector_generation as string,
        coordinate.topic as string,
        coordinate.partition as number,
        BigInt(coordinate.offset as string),
      ])
  ) {
    throw new InvalidInputError("source event ID does not match coordinate");
  }
}

function validatePayload(
  raw: Record<string, unknown>,
  entity: ImportEntity,
): void {
  const payload = object(raw.payload);
  const idName = `${entity}_id`;
  exact(payload, expectedPayloadKeys(entity));
  if (payload[idName] !== raw.entity_id)
    throw new InvalidInputError("payload entity ID mismatch");
  if (entity === "site" || entity === "bin") {
    if (!text(payload.name, 200))
      throw new InvalidInputError("invalid facility name");
  }
  if (
    entity !== "site" &&
    (typeof payload.site_id !== "string" || !isUuid(payload.site_id))
  )
    throw new InvalidInputError("invalid site reference");
  if (entity === "device") {
    if (
      payload.bin_id !== null &&
      (typeof payload.bin_id !== "string" || !isUuid(payload.bin_id))
    )
      throw new InvalidInputError("invalid bin reference");
    if (
      !text(payload.serial_number, 128) ||
      (payload.status !== "active" &&
        payload.status !== "disabled" &&
        payload.status !== "deleted")
    )
      throw new InvalidInputError("invalid device payload");
  }
}
