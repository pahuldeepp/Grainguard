import type { AckQueue, AlertsClient, Identity } from '@greenguard/mobile-core';
import type { TimelineEntry } from '../ui/alerts';
import type { AlertReadings } from '../ui/readings';

export type AlertsPort = Pick<
  AlertsClient,
  'list' | 'detail' | 'acknowledge' | 'clearCache'
>;

export interface Connectivity {
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export interface SessionPort {
  identity(): Promise<Identity | null>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  switchTenant(): Promise<void>;
  // Live only: abandon a sign-in that is waiting for the browser redirect.
  cancelSignIn?(): void;
  // Optional human name of the signed-in tenant (demo data only).
  tenantName?(identity: Identity): string;
}

export interface AppServices {
  mode: 'demo' | 'live';
  // False when this build has no sign-in endpoints (a release build today).
  signInAvailable?: boolean;
  session: SessionPort;
  alerts: AlertsPort;
  queue: AckQueue;
  connectivity: Connectivity;
  // Bin/site display text; live mode only knows the bin id.
  describeBin(binId: string): { bin: string; site?: string };
  // Demo only: fixture readings, cables and trend. Live mode has none yet.
  readings?(alertId: string): AlertReadings | undefined;
  // Demo only: fixture history. Live mode derives it from the alert fields.
  timeline?(alertId: string): TimelineEntry[] | undefined;
  // Demo only: force the app offline to watch the queue.
  simulateOffline?(offline: boolean): void;
  isSimulatedOffline?(): boolean;
}
