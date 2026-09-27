// DEMO FIXTURE MODE. Fake session, fake alerts client and a simulated network
// switch, backed by the REAL AckQueue from the tested core. Nothing here talks
// to an IdP or the BFF, and the factory refuses to run in a release build.
import { AckQueue, GraphqlError } from '@greenguard/mobile-core';
import type {
  AlertView,
  AlertPage,
  Identity,
  SecureStore,
} from '@greenguard/mobile-core';
import type { AppServices, Connectivity } from '../services/types';
import {
  DEMO_BINS,
  DEMO_READINGS,
  DEMO_TENANTS,
  demoAlerts,
  demoTimeline,
} from './data';

const DEMO_SUBJECT = 'demo-operator';

export interface DemoOptions {
  queueStorage: SecureStore;
  // Real device connectivity (NetInfo); omitted in tests.
  deviceConnectivity?: Connectivity;
  now?: () => number;
}

export function createDemoServices(options: DemoOptions): AppServices {
  if (!__DEV__) throw new Error('Demo data is disabled in release builds');
  const now = options.now ?? Date.now;
  const store = demoAlerts(now());
  const usedKeys = new Set<string>();
  let tenantIndex = 0;
  let signedIn = true;
  let simulatedOffline = false;
  let deviceOnline = options.deviceConnectivity?.isOnline() ?? true;
  const listeners = new Set<(online: boolean) => void>();

  const isOnline = () => deviceOnline && !simulatedOffline;
  const notify = () => listeners.forEach(listener => listener(isOnline()));
  options.deviceConnectivity?.subscribe(online => {
    deviceOnline = online;
    notify();
  });

  const tenant = () => DEMO_TENANTS[tenantIndex];
  const identity = (): Identity => ({
    tenantId: tenant().tenantId,
    subject: DEMO_SUBJECT,
  });
  const requireOnline = () => {
    if (!isOnline()) throw new GraphqlError('Network unavailable (demo)', 0);
  };
  const rows = () => store[tenant().tenantId];
  const find = (id: string) => rows().find(row => row.alertId === id);

  const alerts: AppServices['alerts'] = {
    clearCache: () => undefined,
    async list(): Promise<AlertPage> {
      requireOnline();
      return { items: rows().map(row => ({ ...row })), nextCursor: null };
    },
    async detail(id): Promise<AlertView | null> {
      requireOnline();
      const row = find(id);
      return row ? { ...row } : null;
    },
    async acknowledge(id, version, idempotencyKey, expected) {
      requireOnline();
      if (
        expected.tenantId !== tenant().tenantId ||
        expected.subject !== DEMO_SUBJECT
      )
        throw new GraphqlError('Identity changed (demo)', 403);
      const row = find(id);
      if (!row) throw new GraphqlError('Alert not found (demo)', 404);
      // Replays with the same key are the same command.
      if (!usedKeys.has(idempotencyKey)) {
        if (row.state !== 'open' || row.version !== version)
          throw new GraphqlError('Already acknowledged (demo)', 409);
        usedKeys.add(idempotencyKey);
        row.state = 'acknowledged';
        row.acknowledgedAt = new Date(now()).toISOString();
        row.acknowledgedBy = DEMO_SUBJECT;
        row.version = String(Number(row.version) + 1);
      }
      return {
        episodeId: `demo-episode-${id}`,
        state: row.state,
        version: row.version,
        eventId: `demo-event-${idempotencyKey}`,
      };
    },
  };

  let counter = 0;
  const queue = new AckQueue(
    {
      acknowledge: (id, version, key, expected) =>
        alerts.acknowledge(id, version, key, expected),
    },
    {
      storage: options.queueStorage,
      now,
      newId: () => `demo-ack-${now()}-${counter++}`,
      random: Math.random,
      isOnline,
    },
  );

  return {
    mode: 'demo',
    alerts,
    queue,
    connectivity: {
      isOnline,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    session: {
      identity: async () => (signedIn ? identity() : null),
      signIn: async () => {
        signedIn = true;
      },
      signOut: async () => {
        signedIn = false;
      },
      switchTenant: async () => {
        tenantIndex = (tenantIndex + 1) % DEMO_TENANTS.length;
      },
      tenantName: () => tenant().name,
    },
    describeBin: binId => DEMO_BINS[binId] ?? { bin: binId },
    readings: alertId => DEMO_READINGS[alertId],
    timeline: alertId => {
      const base = demoTimeline(alertId, now());
      const row = find(alertId);
      if (!base || !row) return undefined;
      return row.acknowledgedAt
        ? [
            ...base,
            {
              label: 'Acknowledged',
              when: row.acknowledgedAt,
              detail: row.acknowledgedBy ? 'by you' : undefined,
            },
          ]
        : base;
    },
    simulateOffline(offline) {
      simulatedOffline = offline;
      notify();
    },
    isSimulatedOffline: () => simulatedOffline,
  };
}
