// Sensor readings and cable layout for an alert. Only the demo fixtures supply
// this today: the mobile core does not call the Read API's latest/48h history
// queries yet, so live mode has none and the UI says so.
export type Metric = 'temperature' | 'moisture' | 'co2';

export interface CablePoint {
  depthM: number;
  tempC: number;
}

export interface BinCables {
  heightM: number;
  // Depth of stored grain below its surface, in metres.
  grainDepthM: number;
  warmFromC: number;
  hotFromC: number;
  cables: { id: number; points: CablePoint[] }[];
}

export interface AlertReadings {
  temperatureC: number;
  temperatureLimitC: number;
  moisturePct: number;
  moistureLimitPct: number;
  co2Ppm: number;
  co2LimitPpm: number;
  trigger: Metric;
  // Hourly values of the triggering metric, oldest first.
  trend24h: number[];
  bin?: BinCables;
}

export const METRIC_LABEL: Record<Metric, string> = {
  temperature: 'Temperature',
  moisture: 'Moisture',
  co2: 'CO2',
};

export function groupThousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function metricParts(
  m: Metric,
  v: number,
): { num: string; unit: string } {
  if (m === 'temperature') return { num: v.toFixed(1), unit: '\u00B0C' };
  if (m === 'moisture') return { num: v.toFixed(1), unit: '%' };
  return { num: groupThousands(v), unit: 'ppm' };
}

export function formatMetric(metric: Metric, value: number): string {
  if (metric === 'temperature') return `${value.toFixed(1)} °C`;
  if (metric === 'moisture') return `${value.toFixed(1)}%`;
  return `${groupThousands(value)} ppm`;
}

export function metricValue(r: AlertReadings, m: Metric): number {
  return m === 'temperature'
    ? r.temperatureC
    : m === 'moisture'
    ? r.moisturePct
    : r.co2Ppm;
}

export function metricLimit(r: AlertReadings, m: Metric): number {
  return m === 'temperature'
    ? r.temperatureLimitC
    : m === 'moisture'
    ? r.moistureLimitPct
    : r.co2LimitPpm;
}

export function isOver(r: AlertReadings, m: Metric): boolean {
  return metricValue(r, m) > metricLimit(r, m);
}

// "Moisture 16.8%, limit 14": the reading that triggered the alert.
export function triggerText(r: AlertReadings): string {
  const m = r.trigger;
  const limit = metricLimit(r, m);
  return `${METRIC_LABEL[m]} ${formatMetric(m, metricValue(r, m))}, limit ${
    m === 'co2' ? groupThousands(limit) : limit
  }`;
}

export type Band = 'normal' | 'warm' | 'hot';

export function bandOf(bin: BinCables, tempC: number): Band {
  return tempC >= bin.hotFromC
    ? 'hot'
    : tempC >= bin.warmFromC
    ? 'warm'
    : 'normal';
}

export function sensorLabel(cableId: number, p: CablePoint): string {
  return `Cable ${cableId}, ${p.depthM} m: ${p.tempC.toFixed(1)} °C`;
}

export function hottest(
  bin: BinCables,
): { cableId: number; point: CablePoint } | undefined {
  let best: { cableId: number; point: CablePoint } | undefined;
  for (const c of bin.cables)
    for (const point of c.points)
      if (!best || point.tempC > best.point.tempC)
        best = { cableId: c.id, point };
  return best;
}
