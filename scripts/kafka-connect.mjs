import {
  databases,
  notificationConnectors,
  controlConnectors,
  billingConnectors,
  contactConnectors,
  connectorName,
  connectorConfig,
  allConnectorConfigs,
  validateSharedDatabaseHeartbeatConfigs,
  registerConnector,
} from "./events-lib.mjs";
import {
  registerAndValidateContactSchemas,
  validateRegisteredContactSchemas,
} from "./contacts-schema.mjs";

const configs = allConnectorConfigs();
validateSharedDatabaseHeartbeatConfigs(configs);

// Register the checked-in contracts before Debezium starts its initial snapshot.
// The converter must then publish values compatible with these exact subjects.
for (const { subject } of await registerAndValidateContactSchemas())
  console.log(
    `${subject}: Avro contract registered with BACKWARD compatibility`,
  );

for (const database of [
  ...databases,
  ...notificationConnectors,
  ...controlConnectors,
  ...billingConnectors,
  ...contactConnectors,
]) {
  const name = connectorName(database);
  await registerConnector(name, connectorConfig(database));
  console.log(`${name}: connector and task RUNNING`);
}

// Verify the actual converter-registered latest schema, not a locally inferred one.
await validateRegisteredContactSchemas();
console.log(
  "notification contacts: Debezium Avro schemas match checked-in contracts",
);
