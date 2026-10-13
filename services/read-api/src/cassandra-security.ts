import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import cassandra from "cassandra-driver";

export function cassandraSecurity(
  env: NodeJS.ProcessEnv,
): Pick<cassandra.ClientOptions, "authProvider" | "sslOptions"> {
  const username = env.CASSANDRA_USERNAME ?? "";
  const password = env.CASSANDRA_PASSWORD ?? "";
  if (Boolean(username) !== Boolean(password)) {
    throw new Error(
      "CASSANDRA_USERNAME and CASSANDRA_PASSWORD must be supplied together",
    );
  }
  const caFile = env.CASSANDRA_TLS_CA_FILE ?? "";
  const serverName = env.CASSANDRA_TLS_SERVER_NAME ?? "";
  if (
    env.CASSANDRA_REQUIRE_SECURE === "1" &&
    (!username || !caFile || !serverName)
  ) {
    throw new Error(
      "CASSANDRA_REQUIRE_SECURE requires credentials and verified TLS",
    );
  }
  if (Boolean(caFile) !== Boolean(serverName)) {
    throw new Error(
      "CASSANDRA_TLS_CA_FILE and CASSANDRA_TLS_SERVER_NAME must be supplied together",
    );
  }
  const ca = caFile ? readFileSync(caFile, "utf8") : undefined;
  if (ca !== undefined) {
    try {
      new X509Certificate(ca);
    } catch {
      throw new Error("Cassandra TLS CA has no valid PEM certificate");
    }
  }
  return {
    ...(username
      ? {
          authProvider: new cassandra.auth.PlainTextAuthProvider(
            username,
            password,
          ),
        }
      : {}),
    ...(ca
      ? {
          sslOptions: {
            ca,
            servername: serverName,
            rejectUnauthorized: true,
            minVersion: "TLSv1.2" as const,
          },
        }
      : {}),
  };
}
