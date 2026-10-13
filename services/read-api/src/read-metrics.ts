import type { ReadLeaseAuthority } from "@greenguard/membership-client";

type Operation = "acquire" | "admit" | "release";
type Outcome = "success" | "error";
const bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];
/** Fixed operation/outcome labels: no tenant, route, token or endpoint labels. */
export class ReadAdmissionMetrics {
  private readonly observations = new Map<
    string,
    { count: number; sum: number; buckets: number[] }
  >();
  constructor(private readonly now = () => performance.now()) {}
  async measure<T>(operation: Operation, work: () => Promise<T>): Promise<T> {
    const started = this.now();
    let outcome: Outcome = "success";
    try {
      return await work();
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      const seconds = Math.max(0, (this.now() - started) / 1000);
      const key = `${operation},${outcome}`;
      const value = this.observations.get(key) ?? {
        count: 0,
        sum: 0,
        buckets: bounds.map(() => 0),
      };
      value.count++;
      value.sum += seconds;
      bounds.forEach((bound, index) => {
        if (seconds <= bound) value.buckets[index]++;
      });
      this.observations.set(key, value);
    }
  }
  prometheus(): string {
    const name = "greenguard_read_admission_duration_seconds";
    const lines = [
      `# HELP ${name} Read authority RPC duration and call count.`,
      `# TYPE ${name} histogram`,
    ];
    for (const operation of ["acquire", "admit", "release"] as const)
      for (const outcome of ["success", "error"] as const) {
        const value = this.observations.get(`${operation},${outcome}`) ?? {
          count: 0,
          sum: 0,
          buckets: bounds.map(() => 0),
        };
        const labels = `operation="${operation}",outcome="${outcome}"`;
        bounds.forEach((bound, index) =>
          lines.push(
            `${name}_bucket{${labels},le="${bound}"} ${value.buckets[index]}`,
          ),
        );
        lines.push(
          `${name}_bucket{${labels},le="+Inf"} ${value.count}`,
          `${name}_sum{${labels}} ${value.sum}`,
          `${name}_count{${labels}} ${value.count}`,
        );
      }
    return lines.join("\n") + "\n";
  }
}
export function instrumentReadAuthority(
  authority: ReadLeaseAuthority,
  metrics: ReadAdmissionMetrics,
): ReadLeaseAuthority {
  return {
    acquire: (tenant, options) =>
      metrics.measure("acquire", () => authority.acquire(tenant, options)),
    admit: (lease, options) =>
      metrics.measure("admit", () => authority.admit(lease, options)),
    release: (lease) =>
      metrics.measure("release", () => authority.release(lease)),
  };
}
