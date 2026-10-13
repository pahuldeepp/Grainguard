import type { AccessTokenProvider } from "./provisioning";
import { executeOperation } from "./graphql-client";

export interface MlOperationsSnapshot {
  capturedAt: string;
  scorerReady: boolean;
  predictionsTotal: number;
  inferenceP95Ms: number | null;
  canaryPercentage: number;
  model: {
    name: string;
    version: string;
    mode: string;
    dataOrigin: string;
    productionEligible: boolean;
    status: string;
  };
  models: Array<{
    name: string;
    version: string;
    mode: string;
    dataOrigin: string;
    productionEligible: boolean;
    status: string;
  }>;
  drift: Array<{
    feature: string;
    psi: number | null;
    sampleCount: number;
    status: string;
  }>;
  performance: {
    status: string;
    brierScore: number | null;
    sampleCount: number;
    evaluatedAt: string | null;
  };
  retraining: {
    status: string;
    runId: string | null;
    completedAt: string | null;
  };
  analytics: {
    status: "ready" | "unavailable";
    rows: number;
    bins: number;
    averageTemperatureC: number | null;
    averageHumidityPercent: number | null;
  };
}

const operation = `query MlOperations { mlOperations { capturedAt scorerReady predictionsTotal inferenceP95Ms canaryPercentage model { name version mode dataOrigin productionEligible status } models { name version mode dataOrigin productionEligible status } drift { feature psi sampleCount status } performance { status brierScore sampleCount evaluatedAt } retraining { status runId completedAt } analytics { status rows bins averageTemperatureC averageHumidityPercent } } }`;

export class MlApi {
  constructor(private readonly getAccessToken: AccessTokenProvider) {}

  async snapshot(): Promise<MlOperationsSnapshot> {
    const data = await executeOperation<{ mlOperations: MlOperationsSnapshot }>(
      this.getAccessToken,
      operation,
      {},
      {
        signIn: "Sign in to view ML operations.",
        request: "ML operations request failed",
        empty: "ML operations are temporarily unavailable.",
      },
    );
    return data.mlOperations;
  }

  async action(action: "promote" | "rollback" | "retrain", version?: string) {
    const operations = {
      promote: `mutation PromoteMlModel($version: String!) { promoteMlModel(version: $version) { action accepted message runId } }`,
      rollback: `mutation RollbackMlModel($version: String) { rollbackMlModel(version: $version) { action accepted message runId } }`,
      retrain: `mutation StartMlRetraining { startMlRetraining { action accepted message runId } }`,
    } as const;
    const data = await executeOperation<{
      promoteMlModel?: { message: string };
      rollbackMlModel?: { message: string };
      startMlRetraining?: { message: string };
    }>(
      this.getAccessToken,
      operations[action],
      action === "promote" || action === "rollback"
        ? { version: version ?? "" }
        : {},
      {
        signIn: "Sign in to manage ML operations.",
        request: "ML operation failed",
        empty: "ML operation unavailable.",
      },
    );
    return data[
      `${action === "retrain" ? "startMlRetraining" : `${action}MlModel`}` as keyof typeof data
    ];
  }
}
