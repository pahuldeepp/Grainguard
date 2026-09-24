import {
  databases,
  connectorName,
  connectorConfig,
  registerConnector,
} from "./events-lib.mjs";

for (const database of databases) {
  const name = connectorName(database);
  await registerConnector(name, connectorConfig(database));
  console.log(`${name}: connector and task RUNNING`);
}
