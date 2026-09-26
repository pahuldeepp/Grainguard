import {
  databases,
  connectorName,
  allConnectorConfigs,
  registerConnector,
  validateSharedDatabaseHeartbeatConfigs,
} from "./events-lib.mjs";

const configs = allConnectorConfigs();
validateSharedDatabaseHeartbeatConfigs(configs);

for (const database of databases) {
  const name = connectorName(database);
  await registerConnector(name, configs[`${database}-outbox`]);
  console.log(`${name}: connector and task RUNNING`);
}
