import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rootCertificates } from "node:tls";
import test from "node:test";
import { cassandraSecurity } from "./cassandra-security.js";

test("Cassandra client rejects incomplete credentials and TLS config", () => {
  assert.throws(
    () => cassandraSecurity({ CASSANDRA_USERNAME: "reader" }),
    /supplied together/,
  );
  assert.throws(
    () => cassandraSecurity({ CASSANDRA_TLS_CA_FILE: "/missing" }),
    /supplied together/,
  );
  assert.throws(
    () =>
      cassandraSecurity({
        CASSANDRA_TLS_CA_FILE: "/missing",
        CASSANDRA_TLS_SERVER_NAME: "cassandra",
      }),
    /ENOENT/,
  );
  assert.throws(
    () => cassandraSecurity({ CASSANDRA_REQUIRE_SECURE: "1" }),
    /requires credentials and verified TLS/,
  );
});

test("Cassandra client enables hostname and chain verification", () => {
  const path = join(mkdtempSync(join(tmpdir(), "gg-cassandra-")), "ca.pem");
  writeFileSync(path, rootCertificates[0]);
  const options = cassandraSecurity({
    CASSANDRA_USERNAME: "reader",
    CASSANDRA_PASSWORD: "password",
    CASSANDRA_TLS_CA_FILE: path,
    CASSANDRA_TLS_SERVER_NAME: "greenguard-cassandra",
  });
  assert.ok(options.authProvider);
  assert.equal(options.sslOptions?.servername, "greenguard-cassandra");
  assert.equal(options.sslOptions?.rejectUnauthorized, true);
});
