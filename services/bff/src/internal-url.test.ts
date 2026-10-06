import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedInternalUrl } from "./internal-url.js";
import { ReadClient } from "./read-client.js";
import { AlertClient } from "./alerts.js";
import { ProvisioningClient } from "./provisioning.js";
import { BillingClient } from "./billing.js";
import { NotificationClient } from "./notifications.js";

test("mesh HTTP is opt-in and limited to Kubernetes Service DNS", () => {
  const previous = process.env.GG_MESH_INTERNAL_HTTP;
  const service = "http://read-api.greenguard.svc.cluster.local:8080";
  try {
    delete process.env.GG_MESH_INTERNAL_HTTP;
    assert.equal(allowedInternalUrl(service), false);
    for (const Client of [
      ReadClient,
      AlertClient,
      ProvisioningClient,
      BillingClient,
      NotificationClient,
    ])
      assert.throws(() => new Client(service), /HTTPS/);
    process.env.GG_MESH_INTERNAL_HTTP = "1";
    assert.equal(allowedInternalUrl(service), true);
    for (const Client of [
      ReadClient,
      AlertClient,
      ProvisioningClient,
      BillingClient,
      NotificationClient,
    ])
      assert.doesNotThrow(() => new Client(service));
    for (const host of [
      "example.com",
      "read-api",
      "read-api.svc",
      "read-api.greenguard.svc.evil.com",
      "127.0.0.2",
      "read_api.greenguard.svc.cluster.local",
    ])
      assert.equal(allowedInternalUrl(`http://${host}`), false);
    assert.equal(
      allowedInternalUrl("http://user:pass@read-api.greenguard.svc"),
      false,
    );
    assert.equal(allowedInternalUrl("ftp://read-api.greenguard.svc"), false);
  } finally {
    if (previous === undefined) delete process.env.GG_MESH_INTERNAL_HTTP;
    else process.env.GG_MESH_INTERNAL_HTTP = previous;
  }
});
