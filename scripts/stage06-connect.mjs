import {
  connectorName,
  connectorConfig,
  registerConnector,
} from "./events-lib.mjs";

// Run after both Stage 06 owner migrations have created their publications.
for (const database of ["risk", "alerts"]) {
  const name = connectorName(database);
  await registerConnector(name, connectorConfig(database));
  console.log(`${name}: connector and task RUNNING`);
}
