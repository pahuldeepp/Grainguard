import { createApp, DatabaseProbe } from "./app.js";
const url = process.env.INVENTORY_DATABASE_URL;
if (!url)
  throw new Error(
    "INVENTORY_DATABASE_URL is required. Run make bootstrap and make dev.",
  );
const app = await createApp(new DatabaseProbe(url));
await app.listen(
  Number(process.env.PORT || 3001),
  process.env.HOST || "127.0.0.1",
);
console.log("device-service listening on localhost");
