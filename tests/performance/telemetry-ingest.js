import http from "k6/http";
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";

// Open-arrival-rate ingest workload. It deliberately generates unique,
// idempotent source IDs so retries do not inflate accepted-event counts.
// Fixture tokens and device IDs are loaded from a local, untracked JSON file.
const accepted = new Counter("greenguard_ingest_accepted");
const rejected = new Counter("greenguard_ingest_rejected");
const acceptedRate = new Rate("greenguard_ingest_accepted_rate");
const baseURL = (__ENV.BASE_URL || "").replace(/\/$/, "");
// k6's JS runtime does not provide the browser URL global. Parse only the
// authority fields needed for the explicit loopback/disposable target guards.
const parsedBaseURL = /^(https?):\/\/(\[[0-9a-f:]+\]|[^/:?#]+)(?::\d+)?(?:[/?#]|$)/i.exec(baseURL);
const target = __ENV.GREENGUARD_LOAD_TARGET;
const simulateTrustedProxy = __ENV.SIMULATE_TRUSTED_PROXY === "true";
const runId = __ENV.RUN_ID || "";
const runNonce = Date.now().toString(36);
const rate = Number(__ENV.RATE || 1);
const duration = __ENV.DURATION || "30s";
const preAllocatedVUs = Number(__ENV.PREALLOCATED_VUS || 20);
const maxVUs = Number(__ENV.MAX_VUS || 100);

if (!baseURL || !parsedBaseURL || !["local", "disposable"].includes(target)) {
  throw new Error("Set BASE_URL and GREENGUARD_LOAD_TARGET=local|disposable");
}
const hostname = parsedBaseURL[2].replace(/^\[|\]$/g, "").toLowerCase();
if (
  target === "local" &&
  !["localhost", "127.0.0.1", "::1"].includes(hostname)
) {
  throw new Error("local load runs are restricted to loopback hosts");
}
if (target === "disposable" && (
  __ENV.GREENGUARD_LOAD_ACK !== "I_ACCEPT_WRITING_SYNTHETIC_READINGS" ||
  __ENV.EXPECTED_BASE_URL !== baseURL ||
  parsedBaseURL[1].toLowerCase() !== "https"
)) {
  throw new Error("disposable runs require HTTPS, exact EXPECTED_BASE_URL, and explicit write acknowledgement");
}
if (simulateTrustedProxy && target !== "local") {
  throw new Error("SIMULATE_TRUSTED_PROXY is restricted to local runs");
}
if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(runId)) throw new Error("RUN_ID must be 3-48 lowercase alphanumeric/hyphen characters");
if (!Number.isInteger(rate) || rate < 1 || rate > 50000) throw new Error("RATE must be an integer from 1 to 50000 iterations/s");
if (!Number.isInteger(preAllocatedVUs) || preAllocatedVUs < 1 || !Number.isInteger(maxVUs) || maxVUs < preAllocatedVUs) throw new Error("VUs must be positive integers and MAX_VUS >= PREALLOCATED_VUS");
if (simulateTrustedProxy && maxVUs > 65024) throw new Error("SIMULATE_TRUSTED_PROXY supports at most 65024 VUs");
if (!__ENV.FIXTURES_FILE) throw new Error("FIXTURES_FILE is required; keep its bearer tokens out of source control");

const fixture = JSON.parse(open(__ENV.FIXTURES_FILE));
if (!Array.isArray(fixture.tenants) || fixture.tenants.length === 0) throw new Error("fixture must contain tenants");
for (const tenant of fixture.tenants) {
  if (typeof tenant.bearer_token !== "string" || !tenant.bearer_token ||
      !Array.isArray(tenant.device_ids) || tenant.device_ids.length === 0 ||
      tenant.device_ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
    throw new Error("each fixture tenant needs a bearer_token and lowercase UUID device_ids");
  }
}

export const options = {
  scenarios: {
    ingest: {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration,
      preAllocatedVUs,
      maxVUs,
      exec: "ingestReading",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<300"],
    greenguard_ingest_accepted_rate: ["rate>0.99"],
    dropped_iterations: ["count==0"],
  },
};

export function ingestReading() {
  const tenant = fixture.tenants[(__VU + __ITER) % fixture.tenants.length];
  const device = tenant.device_ids[(__VU * 17 + __ITER) % tenant.device_ids.length];
  const sourceMessageId = `ggload-${runId}-${runNonce}-${__VU}-${__ITER}`;
  const body = JSON.stringify({
    source_message_id: sourceMessageId,
    observed_at: new Date().toISOString(),
    temperature_c: 24 + ((__ITER % 100) / 100),
    relative_humidity_percent: 55 + ((__ITER % 200) / 100),
  });
  const response = http.post(`${baseURL}/v1/devices/${device}/readings`, body, {
    headers: {
      Authorization: `Bearer ${tenant.bearer_token}`,
      "Content-Type": "application/json",
      ...(simulateTrustedProxy ? {
        // RFC 2544 benchmarking address space; the local harness trusts only
        // its loopback peer and uses this to model many clients behind a proxy.
        "X-Forwarded-For": `198.18.${Math.floor((__VU - 1) / 254)}.${((__VU - 1) % 254) + 1}`,
      } : {}),
    },
    tags: { route: "telemetry-ingest" },
    timeout: "10s",
  });
  const ok = check(response, { "ingest accepted (202)": (r) => r.status === 202 });
  acceptedRate.add(ok);
  if (ok) accepted.add(1);
  else {
    rejected.add(1);
    let code = "non_json_response";
    try {
      code = response.json("code") || code;
    } catch {
      // Keep diagnostics limited to an HTTP status and a bounded problem code.
    }
    if (__VU === 1 && __ITER === 0) console.error(`First ingest rejection: HTTP ${response.status}, code=${String(code).slice(0, 64)}`);
  }
}
