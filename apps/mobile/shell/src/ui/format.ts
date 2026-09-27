export function timeAgo(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function titleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Risk score is 0 to 100 in the alert API.
export function formatScore(score: number): string {
  return String(Math.round(score));
}

const UUID_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRawId(text: string): boolean {
  return UUID_LIKE.test(text);
}

export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 4);
}

// Live mode only knows the bin id. A raw UUID is never shown as a title: use
// "Bin" plus its first eight characters. Nothing else is invented.
export function binTitle(bin: string, binId: string): string {
  return isRawId(bin) ? `Bin ${shortId(binId)}` : bin;
}

export function alertLabel(alertId: string): string {
  return isRawId(alertId) ? `Alert ${shortId(alertId)}` : `Alert ${alertId}`;
}

// "grain-temp-hotspot" -> "Grain temp hotspot" (formatting only).
export function ruleLabel(ruleId: string): string {
  return isRawId(ruleId)
    ? `Rule ${shortId(ruleId)}`
    : titleCase(ruleId.replace(/[-_]+/g, ' ')).replace(/\bco2\b/i, 'CO2');
}

export function longTimeAgo(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  const unit = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return unit(hours, 'hour');
  return unit(Math.round(hours / 24), 'day');
}

export function isOpenState(state: string): boolean {
  return state !== 'acknowledged' && state !== 'resolved' && state !== 'closed';
}
