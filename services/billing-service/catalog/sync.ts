import Stripe from "stripe";
import pg from "pg";
import { plans, type PlanKey } from "./plans.js";
import { readConfig } from "../src/config.js";

export interface CatalogPort {
  priceByLookupKey(key: string): Promise<{ amount: number; currency: string } | null>;
  createPrice(key: string, amount: number): Promise<void>;
}

// Re-running after a process crash finds the same lookup key. No Stripe object IDs
// are baked into source or the local plan table.
export async function syncCatalog(port: CatalogPort,
  persist: (key: PlanKey, plan: typeof plans[PlanKey]) => Promise<void>): Promise<void> {
  for (const key of Object.keys(plans) as PlanKey[]) {
    const plan = plans[key];
    if (key !== "free") {
      const remote = await port.priceByLookupKey(plan.lookupKey);
      if (remote) {
        if (remote.amount !== plan.amountCents || remote.currency !== "usd")
          throw new Error(`Stripe lookup key ${plan.lookupKey} has a different price`);
      } else await port.createPrice(plan.lookupKey, plan.amountCents);
    }
    await persist(key, plan);
  }
}

export class StripeCatalogPort implements CatalogPort {
  constructor(private readonly stripe: Stripe) {}

  async priceByLookupKey(key: string) {
    const prices = await this.stripe.prices.list({ lookup_keys: [key], active: true, limit: 2 });
    if (prices.data.length > 1) throw new Error(`multiple active prices for ${key}`);
    const price = prices.data[0];
    if (!price) return null;
    if (price.unit_amount === null || price.recurring?.interval !== "month")
      throw new Error(`lookup key ${key} is not a monthly fixed price`);
    return { amount: price.unit_amount, currency: price.currency };
  }

  async createPrice(key: string, amount: number) {
    const productKey = "greenguard_subscription";
    const products = await this.stripe.products.list({ active: true, limit: 100 });
    let product = products.data.find((value) => value.metadata.catalog_key === productKey);
    if (!product) product = await this.stripe.products.create({ name: "GreenGuard",
      metadata: { catalog_key: productKey } }, { idempotencyKey: `catalog-product:${productKey}` });
    await this.stripe.prices.create({ product: product.id, unit_amount: amount,
      currency: "usd", recurring: { interval: "month" }, lookup_key: key },
    { idempotencyKey: `catalog-price:${key}` });
  }
}

export async function runCatalogSync(env: NodeJS.ProcessEnv) {
  const config = readConfig(env);
  const url = env.BILLING_MIGRATION_URL;
  if (!url?.startsWith("postgresql://")) throw new Error("BILLING_MIGRATION_URL is required");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await syncCatalog(new StripeCatalogPort(new Stripe(config.stripeApiKey)),
      async (key, plan) => {
        await client.query(`INSERT INTO billing_catalog
          (plan_key, plan_version, stripe_lookup_key, limits, features)
          VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)
          ON CONFLICT (plan_key) DO UPDATE SET plan_version=EXCLUDED.plan_version,
            stripe_lookup_key=EXCLUDED.stripe_lookup_key, limits=EXCLUDED.limits,
            features=EXCLUDED.features, updated_at=clock_timestamp()`,
        [key, plan.version, plan.lookupKey, JSON.stringify(plan.limits), JSON.stringify(plan.features)]);
      });
  } finally { await client.end(); }
}

if (process.argv[1]?.endsWith("billing-service/dist/catalog/sync.js"))
  await runCatalogSync(process.env);
