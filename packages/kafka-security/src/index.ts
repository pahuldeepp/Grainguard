import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { KafkaConfig } from "kafkajs";

type Getenv = (key: string) => string | undefined;

// An incomplete secure configuration is a startup error, never a plaintext fallback.
export function kafkaSecurityFromEnv(
  getenv: Getenv = (key) => process.env[key],
): Pick<KafkaConfig, "ssl" | "sasl"> {
  const protocol = (getenv("KAFKA_SECURITY_PROTOCOL") ?? "")
    .trim()
    .toUpperCase();
  const mechanism = (getenv("KAFKA_SASL_MECHANISM") ?? "").trim().toUpperCase();
  const username = getenv("KAFKA_SASL_USERNAME") ?? "";
  const password = getenv("KAFKA_SASL_PASSWORD") ?? "";
  const caFile = getenv("KAFKA_TLS_CA_FILE") ?? "";
  const requireTls =
    (getenv("KAFKA_REQUIRE_TLS") ?? "").toLowerCase() === "true";
  if (
    !requireTls &&
    !protocol &&
    !mechanism &&
    !username &&
    !password &&
    !caFile
  )
    return {};
  if (
    protocol !== "SASL_SSL" ||
    mechanism !== "PLAIN" ||
    !username ||
    !password ||
    !caFile
  )
    throw new Error(
      "Kafka requires SASL_SSL, PLAIN credentials, and a TLS CA file",
    );
  const ca = readFileSync(caFile, "utf8");
  new X509Certificate(ca);
  return {
    ssl: { ca: [ca], rejectUnauthorized: true, minVersion: "TLSv1.2" },
    sasl: { mechanism: "plain", username, password },
  };
}
