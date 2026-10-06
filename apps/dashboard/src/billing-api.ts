import { executeOperation } from "./graphql-client";
import type { AccessTokenProvider } from "./provisioning";

export interface BillingData {
  subscription: {
    status: string;
    planKey: string;
    entitlementPlanKey: string;
    currentPeriodEnd?: string;
    cancelAtPeriodEnd?: boolean;
    version?: string;
  };
  usage: Array<{
    meter: string;
    periodStart: string;
    periodEnd: string;
    state: string;
    total: string;
  }>;
}
export interface BillingCommand {
  commandId: string;
  status: string;
  url?: string | null;
}
const billingQuery = `query Billing { billing { subscription { status planKey entitlementPlanKey currentPeriodEnd cancelAtPeriodEnd version } usage { meter periodStart periodEnd state total } } }`;
const commandQuery = `query BillingCommand($id: ID!) { billingCommand(id: $id) { commandId status url } }`;
export class BillingApi {
  constructor(private readonly getAccessToken: AccessTokenProvider) {}
  async snapshot() {
    const data = await executeOperation<{ billing: BillingData }>(
      this.getAccessToken,
      billingQuery,
      {},
      {
        signIn: "Sign in to view billing.",
        request: "Billing request failed",
        empty: "Billing is temporarily unavailable.",
      },
    );
    return data.billing;
  }
  async checkout(plan: string, successUrl: string, cancelUrl: string) {
    const mutation = `mutation StartBillingCheckout($plan: String!, $successUrl: String!, $cancelUrl: String!, $idempotencyKey: String!) { startBillingCheckout(plan: $plan, successUrl: $successUrl, cancelUrl: $cancelUrl, idempotencyKey: $idempotencyKey) { commandId status url } }`;
    const data = await executeOperation<{
      startBillingCheckout: BillingCommand;
    }>(
      this.getAccessToken,
      mutation,
      { plan, successUrl, cancelUrl, idempotencyKey: crypto.randomUUID() },
      {
        signIn: "Sign in to buy a plan.",
        request: "Checkout request failed",
        empty: "Checkout was not created.",
      },
    );
    return this.awaitCommand(data.startBillingCheckout, "checkout");
  }
  async portal(returnUrl: string) {
    const mutation = `mutation OpenBillingPortal($returnUrl: String!, $idempotencyKey: String!) { openBillingPortal(returnUrl: $returnUrl, idempotencyKey: $idempotencyKey) { commandId status url } }`;
    const data = await executeOperation<{ openBillingPortal: BillingCommand }>(
      this.getAccessToken,
      mutation,
      { returnUrl, idempotencyKey: crypto.randomUUID() },
      {
        signIn: "Sign in to manage billing.",
        request: "Billing portal request failed",
        empty: "Billing portal was not created.",
      },
    );
    return this.awaitCommand(data.openBillingPortal, "billing portal");
  }
  private async awaitCommand(
    initial: BillingCommand,
    action: string,
  ): Promise<BillingCommand> {
    if (initial.url) return initial;
    let current = initial;
    for (
      let attempt = 0;
      attempt < 12 &&
      !current.url &&
      !["failed", "quarantined"].includes(current.status);
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const data = await executeOperation<{ billingCommand: BillingCommand }>(
        this.getAccessToken,
        commandQuery,
        { id: initial.commandId },
        {
          signIn: "Sign in to manage billing.",
          request: "Billing command failed",
          empty: "Billing command was not found.",
        },
      );
      current = data.billingCommand;
    }
    if (["failed", "quarantined"].includes(current.status))
      throw new Error(
        `Stripe could not complete the ${action}. Check the test-mode price catalog and billing service configuration.`,
      );
    if (!current.url)
      throw new Error(
        `Your ${action} is still processing. Wait a moment before trying again.`,
      );
    return current;
  }
}
