/** A requested read minimum, never an authorization credential or shard hint. */
export interface ProjectionWatermark {
  v: 1;
  tenantId: string;
  shardIncarnation: string;
  placementEpoch: string;
  sequence: string;
}

export const READ_BUDGET_HEADER = "x-greenguard-read-budget-ms";
export const WATERMARK_REQUEST_HEADER = "x-greenguard-minimum-watermark";
export const WATERMARK_RESPONSE_HEADER = "x-greenguard-watermark";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
const MAX = 9223372036854775807n;

export class WatermarkError extends Error {
  constructor(readonly code = "invalid_consistency_token") {
    super(code);
  }
}

export function parseWatermark(
  value: string,
  tenantId?: string,
): ProjectionWatermark {
  if (typeof value !== "string" || value.length > 512)
    throw new WatermarkError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new WatermarkError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new WatermarkError();
  const row = parsed as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(",") !==
      "placementEpoch,sequence,shardIncarnation,tenantId,v" ||
    row.v !== 1 ||
    typeof row.tenantId !== "string" ||
    !UUID.test(row.tenantId) ||
    (tenantId !== undefined && row.tenantId !== tenantId) ||
    typeof row.shardIncarnation !== "string" ||
    !UUID.test(row.shardIncarnation) ||
    typeof row.placementEpoch !== "string" ||
    !DECIMAL.test(row.placementEpoch) ||
    BigInt(row.placementEpoch) < 1n ||
    BigInt(row.placementEpoch) > MAX ||
    typeof row.sequence !== "string" ||
    !DECIMAL.test(row.sequence) ||
    BigInt(row.sequence) > MAX
  )
    throw new WatermarkError();
  return {
    v: 1,
    tenantId: row.tenantId,
    shardIncarnation: row.shardIncarnation,
    placementEpoch: row.placementEpoch,
    sequence: row.sequence,
  };
}

export function serializeWatermark(value: ProjectionWatermark): string {
  return JSON.stringify(parseWatermark(JSON.stringify(value)));
}
