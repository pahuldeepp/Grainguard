import { executeOperation } from "./graphql-client";

export interface ProvisioningSaga {
  sagaId: string;
  deviceId: string;
  assetId: string;
  state: string;
  version: number;
  deadlineAt: string;
}

export interface ProvisioningStatus {
  saga: ProvisioningSaga;
  history: {
    version: number;
    action: string;
    reason?: string | null;
    recordedAt: string;
  }[];
}

export interface SessionView {
  subject: string;
  tenantId: string;
  roles: string[];
}

export type AccessTokenProvider = () => Promise<string | null>;

// These operation strings are the public persisted-operation contract of the BFF.
const operations = {
  session: `query Session { session { subject tenantId roles } }`,
  provisioningStatus: `query ProvisioningStatus($id: ID!) { provisioningStatus(id: $id) { saga { tenantId sagaId deviceId assetId state version fencingToken deadlineAt } history { version action actorSub reason recordedAt } } }`,
  startProvisioning: `mutation StartProvisioning($deviceId: ID!, $assetId: ID!, $idempotencyKey: String!) { startProvisioning(deviceId: $deviceId, assetId: $assetId, idempotencyKey: $idempotencyKey) { tenantId sagaId deviceId assetId state version fencingToken deadlineAt } }`,
  redriveProvisioning: `mutation RedriveProvisioning($id: ID!, $reason: String!) { redriveProvisioning(id: $id, reason: $reason) { tenantId sagaId deviceId assetId state version fencingToken deadlineAt } }`,
} as const;

export class ProvisioningApi {
  constructor(private readonly getAccessToken: AccessTokenProvider) {}

  private async execute<T>(
    query: string,
    variables: Record<string, string>,
  ): Promise<T> {
    return executeOperation<T>(this.getAccessToken, query, variables, {
      signIn: "Sign in to manage provisioning.",
      request: "Provisioning request failed",
      empty: "Provisioning returned no data.",
    });
  }

  async session(): Promise<SessionView> {
    const data = await this.execute<{ session: SessionView }>(
      operations.session,
      {},
    );
    return data.session;
  }

  async status(id: string): Promise<ProvisioningStatus> {
    const data = await this.execute<{ provisioningStatus: ProvisioningStatus }>(
      operations.provisioningStatus,
      { id },
    );
    return data.provisioningStatus;
  }

  async start(
    deviceId: string,
    assetId: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ProvisioningSaga> {
    const data = await this.execute<{ startProvisioning: ProvisioningSaga }>(
      operations.startProvisioning,
      { deviceId, assetId, idempotencyKey },
    );
    return data.startProvisioning;
  }

  async redrive(id: string, reason: string): Promise<ProvisioningSaga> {
    const data = await this.execute<{ redriveProvisioning: ProvisioningSaga }>(
      operations.redriveProvisioning,
      { id, reason },
    );
    return data.redriveProvisioning;
  }
}
