// Claims are read only to scope local caches and queues. The BFF verifies the
// token signature; the app never treats these claims as authorization.
export function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Malformed token");
  const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
  );
  return JSON.parse(json) as Record<string, unknown>;
}
