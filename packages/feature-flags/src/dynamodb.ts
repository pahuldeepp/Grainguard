import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type { FlagChange, FlagRule } from "./index.js";

const GLOBAL_SCOPE = "SCOPE#GLOBAL";
const TENANT_ID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const INFRASTRUCTURE_TENANT = "00000000-0000-4000-8000-000000000001";

type SnapshotItem = {
  scope_key: string;
  config_version: number;
  flags: Readonly<Record<string, FlagRule>>;
};

export class DynamoFlagSnapshotStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    if (!tableName.trim()) throw new Error("DynamoDB table name is required");
  }

  close(): void {
    this.client.destroy();
  }

  /**
   * Persist only canonical control-plane snapshots. A conditional put makes
   * replay/out-of-order delivery monotonic across workers and regions. DynamoDB
   * TTL is intentionally absent: expiration must never decide flag correctness.
   */
  async apply(change: FlagChange): Promise<boolean> {
    validateChange(change);
    const scopeKey = keyFor(change);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            scope_key: scopeKey,
            config_version: change.version,
            flags: change.flags,
          } satisfies SnapshotItem,
          ConditionExpression:
            "attribute_not_exists(#version) OR #version < :version",
          ExpressionAttributeNames: { "#version": "config_version" },
          ExpressionAttributeValues: { ":version": change.version },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  async get(
    scope: { tenantId: string } | { global: true },
  ): Promise<FlagChange | undefined> {
    const isGlobal = "global" in scope;
    const scopeKey = isGlobal ? GLOBAL_SCOPE : tenantKey(scope.tenantId);
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { scope_key: scopeKey },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return undefined;
    const item = result.Item as SnapshotItem;
    const change: FlagChange = isGlobal
      ? { scope: "global", version: item.config_version, flags: item.flags }
      : {
          scope: "tenant",
          tenantId: scope.tenantId,
          version: item.config_version,
          flags: item.flags,
        };
    validateChange(change);
    return change;
  }
}

export function createDynamoFlagSnapshotStore(options: {
  tableName: string;
  region?: string;
  endpoint?: string;
  credentials?: DynamoDBClientConfig["credentials"];
}): DynamoFlagSnapshotStore {
  const localCredentials =
    options.endpoint && !options.credentials
      ? { accessKeyId: "local", secretAccessKey: "local" }
      : undefined;
  const client = new DynamoDBClient({
    region: options.region ?? "us-east-1",
    ...(options.endpoint && { endpoint: options.endpoint }),
    ...((options.credentials ?? localCredentials) && {
      credentials: options.credentials ?? localCredentials,
    }),
  });
  return new DynamoFlagSnapshotStore(
    DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    }),
    options.tableName,
  );
}

function validateChange(change: FlagChange): void {
  if (!change || !["tenant", "global"].includes(change.scope))
    throw new Error("invalid flag scope");
  if (
    change.scope === "tenant" &&
    (!change.tenantId || !TENANT_ID.test(change.tenantId))
  )
    throw new Error("tenant snapshot requires a valid tenant ID");
  if (change.scope === "global" && change.tenantId !== undefined)
    throw new Error("global snapshot cannot contain a tenant ID");
  if (change.scope === "tenant" && change.tenantId === INFRASTRUCTURE_TENANT)
    throw new Error(
      "reserved infrastructure tenant cannot be used as a customer tenant",
    );
  if (!Number.isSafeInteger(change.version) || change.version < 0)
    throw new Error("invalid flag snapshot version");
  if (
    !change.flags ||
    typeof change.flags !== "object" ||
    Array.isArray(change.flags)
  )
    throw new Error("invalid flag snapshot values");
  for (const [key, rule] of Object.entries(change.flags)) {
    if (
      !key ||
      !rule ||
      !["boolean", "string", "number"].includes(typeof rule.value)
    )
      throw new Error("invalid flag rule");
    if (typeof rule.value === "number" && !Number.isFinite(rule.value))
      throw new Error("invalid numeric flag");
    if (
      rule.rolloutPercent !== undefined &&
      (typeof rule.value !== "boolean" ||
        !Number.isFinite(rule.rolloutPercent) ||
        rule.rolloutPercent < 0 ||
        rule.rolloutPercent > 100)
    )
      throw new Error("invalid flag rollout percentage");
  }
}

function keyFor(change: FlagChange): string {
  return change.scope === "global" ? GLOBAL_SCOPE : tenantKey(change.tenantId!);
}

function tenantKey(tenantId: string): string {
  if (!TENANT_ID.test(tenantId) || tenantId === INFRASTRUCTURE_TENANT)
    throw new Error("invalid tenant ID");
  return `TENANT#${tenantId.toLowerCase()}`;
}

function isConditionalFailure(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "ConditionalCheckFailedException"
  );
}
