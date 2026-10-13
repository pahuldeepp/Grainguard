import DataLoader from "dataloader";
import { ReadClient, type ReadConsistency } from "./read-client.js";

export function createDeviceLoader(
  read: ReadClient,
  authorization: string,
  tenantId?: string,
  onWatermark?: (token: string) => void,
  options?: Pick<ReadConsistency, "deadline" | "signal">,
): DataLoader<string, Record<string, unknown> | null> {
  return new DataLoader<string, Record<string, unknown> | null>(
    async (ids) => {
      const rows = await read.devices(
        authorization,
        ids,
        tenantId ? { tenantId, onWatermark, ...options } : undefined,
      );
      const byId = new Map(
        rows
          .filter(
            (row) =>
              typeof row.deviceId === "string" && ids.includes(row.deviceId),
          )
          .map((row) => [row.deviceId as string, row]),
      );
      return ids.map((id) => byId.get(id) ?? null);
    },
    { maxBatchSize: 100 },
  );
}
