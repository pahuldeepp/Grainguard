import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReadLeaseAuthority } from "@greenguard/membership-client";
import {
  ReadAdmissionMetrics,
  instrumentReadAuthority,
} from "./read-metrics.js";
test("authority telemetry counts success and failure with bounded non-tenant labels", async () => {
  let clock = 0;
  const metrics = new ReadAdmissionMetrics(() => clock);
  const error = new Error("private tenant detail");
  const authority = instrumentReadAuthority(
    {
      acquire: async () => {
        clock += 10;
        throw error;
      },
      admit: async () => {
        clock += 20;
      },
      release: async () => {
        clock += 30;
      },
    } as ReadLeaseAuthority,
    metrics,
  );
  await assert.rejects(authority.acquire("private-tenant"), (e) => e === error);
  await authority.admit({} as never);
  await authority.release({} as never);
  const text = metrics.prometheus();
  assert.match(text, /operation="acquire",outcome="error"} 1/);
  assert.match(text, /operation="admit",outcome="success"} 1/);
  assert.match(text, /operation="release",outcome="success"} 1/);
  assert.match(text, /operation="acquire",outcome="error",le="0.005"} 0/);
  assert.match(text, /operation="acquire",outcome="error",le="0.01"} 1/);
  assert.equal(text.includes("private"), false);
});
