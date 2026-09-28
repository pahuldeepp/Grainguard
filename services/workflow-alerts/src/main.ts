import { readFileSync } from "node:fs";
import { initTracing } from "@greenguard/otel";
import { startMembershipRuntime } from "@greenguard/membership-client";
import { createAlertsApp } from "./app.js";
import { readConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { startRiskKafkaConsumer } from "./consumer/kafka.js";

// Entry point kept testable: configuration comes in as a parameter.
export async function start(env: NodeJS.ProcessEnv) {
  const config = readConfig(env);
  const db = createDb(config.databaseUrl, 10, env);
  const tokenVerifier = config.auth
    ? await startMembershipRuntime(
        (name) => env[name],
        (path) => readFileSync(path, "utf8"),
        "workflow-alerts",
      )
    : undefined;
  const stopConsumer: { close?: () => Promise<void> } = {};
  const consumerHealth = {
    ready: config.kafkaBrokers.length === 0,
    failed: false,
  };
  const app = await createAlertsApp({
    db,
    stopConsumer,
    consumerHealth,
    actorHmacKey: config.actorHmacKey,
    historyCursorKey: config.historyCursorKey,
    // This verifier validates exactly the configured issuer before returning.
    verifier: tokenVerifier
      ? {
          verify: async (authorization) => ({
            ...(await tokenVerifier.verify(authorization)),
            issuer: config.auth!.issuer,
          }),
          close: () => tokenVerifier.close(),
        }
      : undefined,
    tracing:
      config.otlpEndpoint === undefined
        ? undefined
        : initTracing({
            serviceName: "workflow-alerts",
            otlpEndpoint: config.otlpEndpoint,
            sampleRatio: 1,
          }),
  });
  await app.listen(config.port, config.host);
  if (config.kafkaBrokers.length > 0) {
    try {
      const stop = await startRiskKafkaConsumer(
        db,
        config.kafkaBrokers,
        config.kafkaGroup,
        () => {
          consumerHealth.failed = true;
          consumerHealth.ready = false;
        },
      );
      stopConsumer.close = stop;
      if (!consumerHealth.failed) consumerHealth.ready = true;
    } catch (error) {
      await app.close();
      throw error;
    }
  }
  return app;
}

if (process.argv[1]?.endsWith("workflow-alerts/dist/main.js"))
  await start(process.env);
