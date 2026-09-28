const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function localPort(env, key, fallback) {
  const value = env.get(key);
  if (!value) return fallback;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${key} must be a valid local PostgreSQL URL before bootstrap`,
    );
  }
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !loopbackHosts.has(url.hostname)
  ) {
    throw new Error(
      `${key} must target a loopback PostgreSQL endpoint before bootstrap`,
    );
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${key} must include a valid loopback port before bootstrap`,
    );
  }
  return port;
}

export function connectionPorts(env) {
  return {
    direct: localPort(env, "POSTGRES_ADMIN_URL", 55432),
    pooled: localPort(env, "INVENTORY_DATABASE_URL", 56432),
  };
}
