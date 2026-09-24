import { initTracing } from "@greenguard/otel";
import { createTokenVerifier } from "@greenguard/tenant-auth";
import { createAlertsApp } from "./app.js";
import { readConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { startRiskKafkaConsumer } from "./consumer/kafka.js";

// Entry point kept testable: configuration comes in as a parameter.
export async function start(env: NodeJS.ProcessEnv) {
  const config = readConfig(env);
  const db = createDb(config.databaseUrl);
  const stopConsumer: { close?: () => Promise<void> } = {};
  const consumerHealth = {
    ready: config.kafkaBrokers.length === 0,
    failed: false,
  };
  const app = await createAlertsApp({
    db,
    stopConsumer,
    consumerHealth,
    verifier:
      config.auth &&
      createTokenVerifier({
        issuer: config.auth.issuer,
        audience: config.auth.audience,
        keys: { jwksUrl: config.auth.jwksUrl },
      }),
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
