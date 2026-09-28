export interface PublicOidcConfig {
  authority: string;
  clientId: string;
  tokenMode: "audience" | "cognito-access";
  audience?: string;
  resource?: string;
}

let deployed: PublicOidcConfig | null = null;

function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.hostname !== "example.com" &&
      !url.hostname.endsWith(".example.com")
    );
  } catch {
    return false;
  }
}

export function validatePublicOidcConfig(input: unknown): PublicOidcConfig {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid public OIDC configuration");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "authority",
          "clientId",
          "tokenMode",
          "audience",
          "resource",
        ].includes(key),
    )
  )
    throw new Error("Unexpected public OIDC configuration field");
  if (
    !httpsUrl(value.authority) ||
    typeof value.clientId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(value.clientId) ||
    (value.tokenMode !== "audience" && value.tokenMode !== "cognito-access") ||
    (value.tokenMode === "audience" &&
      (typeof value.audience !== "string" ||
        !value.audience ||
        value.resource !== undefined)) ||
    (value.tokenMode === "cognito-access" &&
      (value.audience !== undefined ||
        (value.resource !== undefined && !httpsUrl(value.resource))))
  )
    throw new Error("Incomplete public OIDC configuration");
  return value as unknown as PublicOidcConfig;
}

export async function loadPublicOidcConfig(
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("/config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Public OIDC configuration unavailable");
  const parsed: unknown = await response.json();
  deployed = validatePublicOidcConfig(parsed);
}

export function deployedOidcConfig(): PublicOidcConfig | null {
  return deployed;
}
