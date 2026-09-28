import { Buffer } from "node:buffer";

export interface BillingConfig {
  databaseUrl: string;
  stripeApiKey: string;
  webhookSecrets: readonly string[];
  inboxEncryptionKey: Buffer;
  returnOrigins: readonly string[];
  graceDays: number;
  port: number;
  host: string;
}

// Parse without interpolating secret values into errors or logs.
export function readConfig(env: NodeJS.ProcessEnv): BillingConfig {
  const stripeApiKey = env.STRIPE_API_KEY ?? "";
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(stripeApiKey))
    throw new Error("Stripe test-mode API key is required; live keys are forbidden");
  const webhookSecrets = (env.STRIPE_WEBHOOK_SECRETS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (webhookSecrets.length < 1 || webhookSecrets.length > 2 ||
      webhookSecrets.some((value) => !/^whsec_[A-Za-z0-9]+$/.test(value)))
    throw new Error("one or two Stripe webhook signing secrets are required");
  const encodedKey = env.BILLING_INBOX_ENCRYPTION_KEY ?? "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encodedKey))
    throw new Error("a base64 32-byte inbox encryption key is required");
  const inboxEncryptionKey = Buffer.from(encodedKey, "base64");
  if (inboxEncryptionKey.length !== 32)
    throw new Error("a base64 32-byte inbox encryption key is required");
  const databaseUrl = env.BILLING_DATABASE_URL ?? "";
  if (!databaseUrl.startsWith("postgresql://"))
    throw new Error("BILLING_DATABASE_URL is required");
  const returnOrigins = (env.BILLING_RETURN_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!returnOrigins.length || returnOrigins.some((value) => {
    try {
      const url = new URL(value);
      return url.origin !== value || (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost");
    } catch {
      return true;
    }
  })) throw new Error("BILLING_RETURN_ORIGINS must contain exact HTTPS or local origins");
  const graceDays = Number(env.BILLING_GRACE_DAYS ?? "14");
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 90)
    throw new Error("BILLING_GRACE_DAYS must be an integer from 0 to 90");
  const port = Number(env.BILLING_PORT ?? "3021");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("BILLING_PORT is invalid");
  return { databaseUrl, stripeApiKey, webhookSecrets, inboxEncryptionKey,
    returnOrigins, graceDays, port, host: env.BILLING_HOST ?? "127.0.0.1" };
}

export function allowedReturnUrl(raw: string, origins: readonly string[]): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("invalid return URL"); }
  if (!origins.includes(url.origin) || (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost"))
    throw new Error("return URL origin is not allowed");
  if (url.username || url.password || url.hash) throw new Error("invalid return URL");
  return url.toString();
}
