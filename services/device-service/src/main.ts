import { createApp, DatabaseProbe } from "./app.js";
import { readConfig } from "./config.js";
const config = readConfig(process.env);
export const app = await createApp(new DatabaseProbe(config.databaseUrl));
await app.listen(config.port, config.host);
console.log("device-service listening on localhost");
