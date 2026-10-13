// HTTP is permitted only for Kubernetes Service DNS when the deployment has
// explicitly enabled Istio STRICT mTLS and matching NetworkPolicy.
export function allowedInternalUrl(raw: string): boolean {
  const url = new URL(raw);
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return true;
  if (process.env.GG_MESH_INTERNAL_HTTP !== "1") return false;
  if (url.username || url.password || url.hash) return false;
  return /^(?:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\.){2}svc(?:\.cluster\.local)?$/.test(
    url.hostname,
  );
}
