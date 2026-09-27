import DataLoader from "dataloader";
import { ReadClient } from "./read-client.js";

export function createDeviceLoader(
  read: ReadClient,
  authorization: string,
): DataLoader<string, Record<string, unknown> | null> {
  return new DataLoader<string, Record<string, unknown> | null>(
    async (ids) => {
      const rows = await read.devices(authorization, ids);
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
