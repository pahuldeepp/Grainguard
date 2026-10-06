// 310s summary request + up to 10s readiness propagation + 10s cleanup.
export function terminationGraceMs(value?: string): number {
  const parsed = Number(value ?? 340_000);
  return Number.isSafeInteger(parsed) && parsed >= 330_000 && parsed <= 900_000
    ? parsed
    : 340_000;
}
