// DEMO DATA ONLY. Invented tenants, bins and alerts so the shell shows
// populated screens without an IdP or BFF. Never used in a release build.
import type { AlertView } from '@greenguard/mobile-core';

export interface DemoTenant {
  tenantId: string;
  name: string;
}

export const DEMO_TENANTS: DemoTenant[] = [
  { tenantId: 'demo-tenant-prairie', name: 'Prairie Grain Co-op' },
  { tenantId: 'demo-tenant-riverbend', name: 'Riverbend Storage' },
];

export const DEMO_BINS: Record<string, { bin: string; site: string }> = {
  'bin-p-14': { bin: 'Bin 14 (corn)', site: 'North Elevator' },
  'bin-p-07': { bin: 'Bin 7 (wheat)', site: 'North Elevator' },
  'bin-p-22': { bin: 'Bin 22 (soy)', site: 'Highway 9 Yard' },
  'bin-r-03': { bin: 'Bin 3 (barley)', site: 'Riverbend Main' },
  'bin-r-11': { bin: 'Bin 11 (canola)', site: 'Riverbend Main' },
};

export function demoAlerts(now: number): Record<string, AlertView[]> {
  const ago = (minutes: number) =>
    new Date(now - minutes * 60_000).toISOString();
  const alert = (
    alertId: string,
    binId: string,
    severity: string,
    score: number,
    minutes: number,
    ruleId: string,
    extra: Partial<AlertView> = {},
  ): AlertView => ({
    alertId,
    ruleId,
    binId,
    state: 'open',
    severity,
    score,
    version: '1',
    openedAt: ago(minutes),
    acknowledgedAt: null,
    escalationLevel: 0,
    ...extra,
  });
  return {
    'demo-tenant-prairie': [
      alert('a-1001', 'bin-p-14', 'critical', 93, 12, 'grain-temp-hotspot'),
      alert('a-1002', 'bin-p-07', 'high', 78, 55, 'moisture-rising', {
        escalationLevel: 1,
      }),
      alert('a-1003', 'bin-p-22', 'medium', 52, 180, 'co2-elevated'),
      alert('a-1004', 'bin-p-14', 'low', 31, 1440, 'sensor-gap', {
        state: 'acknowledged',
        acknowledgedAt: ago(1400),
        acknowledgedBy: 'demo-operator',
        version: '2',
      }),
    ],
    'demo-tenant-riverbend': [
      alert('b-2001', 'bin-r-03', 'high', 81, 25, 'grain-temp-hotspot'),
      alert('b-2002', 'bin-r-11', 'medium', 47, 95, 'moisture-rising'),
    ],
  };
}

// DEMO ONLY: a small fixture history so the timeline can be reviewed. The real
// BFF does not expose transition history yet (see STAGE_10E_UI_VALIDATION.md).
export function demoTimeline(
  alertId: string,
  now: number,
): { label: string; when?: string; detail?: string }[] | undefined {
  const ago = (m: number) => new Date(now - m * 60_000).toISOString();
  const table: Record<
    string,
    { label: string; when?: string; detail?: string }[]
  > = {
    'a-1001': [
      { label: 'Opened', when: ago(12) },
      { label: 'Escalated to level 1', when: ago(6) },
    ],
    'a-1002': [
      { label: 'Opened', when: ago(55) },
      { label: 'Escalated to level 1', when: ago(30) },
    ],
  };
  return table[alertId];
}

// DEMO ONLY readings, cables and 24 h trends. Every number is invented.
import type { AlertReadings } from '../ui/readings';

const ramp = (from: number, to: number, n = 24, wobble = 0.3): number[] =>
  Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return (
      Math.round(
        (from + (to - from) * t ** 2 + Math.sin(i * 1.7) * wobble) * 10,
      ) / 10
    );
  });

const cables = (
  hot: { cable: number; depth: number; temp: number } | null,
  base = 21.5,
) =>
  [1, 2, 3, 4, 5].map(id => ({
    id,
    points: [1.5, 3.0, 4.5, 6.0].map((depthM, k) => {
      let tempC = base + k * 0.4 + id * 0.15;
      if (hot) {
        const dc = Math.abs(id - hot.cable);
        const dd = Math.abs(depthM - hot.depth);
        if (dc === 0 && dd === 0) tempC = hot.temp;
        else if (dc <= 1 && dd <= 1.5) tempC = hot.temp - 4 - dc * 1.5 - dd;
      }
      return { depthM, tempC: Math.round(tempC * 10) / 10 };
    }),
  }));

const bin = (hot: { cable: number; depth: number; temp: number } | null) => ({
  heightM: 9,
  grainDepthM: 7,
  warmFromC: 25,
  hotFromC: 30,
  cables: cables(hot),
});

export const DEMO_READINGS: Record<string, AlertReadings> = {
  'a-1001': {
    temperatureC: 34.2,
    temperatureLimitC: 28,
    moisturePct: 13.1,
    moistureLimitPct: 14,
    co2Ppm: 640,
    co2LimitPpm: 1000,
    trigger: 'temperature',
    trend24h: ramp(23.4, 34.2),
    bin: bin({ cable: 3, depth: 4.5, temp: 34.2 }),
  },
  'a-1002': {
    temperatureC: 21.8,
    temperatureLimitC: 28,
    moisturePct: 16.8,
    moistureLimitPct: 14,
    co2Ppm: 720,
    co2LimitPpm: 1000,
    trigger: 'moisture',
    trend24h: ramp(13.6, 16.8, 24, 0.15),
    bin: bin(null),
  },
  'a-1003': {
    temperatureC: 22.6,
    temperatureLimitC: 28,
    moisturePct: 12.4,
    moistureLimitPct: 14,
    co2Ppm: 1180,
    co2LimitPpm: 1000,
    trigger: 'co2',
    trend24h: ramp(760, 1180, 24, 25),
    bin: bin(null),
  },
  'a-1004': {
    temperatureC: 20.9,
    temperatureLimitC: 28,
    moisturePct: 12.9,
    moistureLimitPct: 14,
    co2Ppm: 590,
    co2LimitPpm: 1000,
    trigger: 'temperature',
    trend24h: ramp(20.5, 20.9, 24, 0.1),
    bin: bin(null),
  },
  'b-2001': {
    temperatureC: 31.0,
    temperatureLimitC: 28,
    moisturePct: 12.2,
    moistureLimitPct: 14,
    co2Ppm: 810,
    co2LimitPpm: 1000,
    trigger: 'temperature',
    trend24h: ramp(24.0, 31.0),
    bin: bin({ cable: 2, depth: 3.0, temp: 31.0 }),
  },
  'b-2002': {
    temperatureC: 22.0,
    temperatureLimitC: 28,
    moisturePct: 14.9,
    moistureLimitPct: 14,
    co2Ppm: 700,
    co2LimitPpm: 1000,
    trigger: 'moisture',
    trend24h: ramp(13.8, 14.9, 24, 0.1),
    bin: bin(null),
  },
};
