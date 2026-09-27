import type { Db, Tx } from "./db.js";
import { withTenant } from "./db.js";
import { audit, context, outbox } from "./events.js";
import { nameId, UUID } from "./ids.js";
import { scheduleUsage } from "./due.js";

export type Meter = "accepted_readings" | "active_devices";
export interface ReadingUsage {
  eventId: string;
  acceptedAt: Date;
}
interface PeriodRow {
  state: "open" | "closed" | "reported";
  total: bigint;
  version: bigint;
  period_end: Date;
}

export function monthStart(value: Date): Date {
  if (Number.isNaN(value.getTime())) throw new Error("invalid usage timestamp");
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}
// Stripe (checked against docs.stripe.com/api/billing/meter-event): a meter event
// timestamp must be within the past 35 calendar days or up to 5 minutes ahead. Report at
// the last second of the usage month, so it falls inside the period, and clamp it into
// the accepted window (one day of margin) so a late close is still accepted and billed.
const METER_WINDOW_MS = 34 * 86_400_000;
export function meterEventTime(periodStart: Date, now: Date): Date {
  const lastSecond = nextMonth(periodStart).getTime() - 1000;
  return new Date(
    Math.min(
      now.getTime(),
      Math.max(lastSecond, now.getTime() - METER_WINDOW_MS),
    ),
  );
}
export function nextMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
}
const reportKey = (tenantId: string, meter: Meter, start: Date) =>
  `usage:${tenantId}:${meter}:${start.toISOString().slice(0, 10)}`;
const periodId = (tenantId: string, meter: Meter, start: Date) =>
  nameId("usage-period", tenantId, meter, start.toISOString());

async function lockPeriod(
  tx: Tx,
  tenantId: string,
  meter: Meter,
  sourceStart: Date,
): Promise<{ start: Date; row: PeriodRow; late: boolean }> {
  let start = sourceStart;
  for (let i = 0; i < 13; i++) {
    const end = nextMonth(start);
    await tx.$executeRaw`INSERT INTO usage_periods
      (tenant_id, meter, period_start, period_end, report_idempotency_key)
      VALUES (${tenantId}::uuid, ${meter}, ${start}, ${end},
        ${reportKey(tenantId, meter, start)}) ON CONFLICT DO NOTHING`;
    const row = (
      await tx.$queryRaw<PeriodRow[]>`SELECT state, total, version, period_end
      FROM usage_periods WHERE tenant_id=${tenantId}::uuid AND meter=${meter}
      AND period_start=${start} FOR UPDATE`
    )[0];
    if (!row) throw new Error("usage period missing after insert");
    if (row.state === "open")
      return { start, row, late: start.getTime() !== sourceStart.getTime() };
    start = nextMonth(start);
  }
  throw new Error("cannot attribute reading to an open usage period");
}

export class BillingUsage {
  constructor(private readonly db: Db) {}

  async rejectSource(
    topic: string,
    partition: number,
    offset: string,
    reason: string,
  ): Promise<void> {
    if (
      !/^[a-z0-9._-]{1,160}$/.test(topic) ||
      !Number.isSafeInteger(partition) ||
      partition < 0 ||
      !/^\d{1,19}$/.test(offset)
    )
      throw new Error("invalid source position");
    await this.db.$executeRaw`INSERT INTO billing_inbox.source_rejections
      (topic, partition, source_offset, reason)
      VALUES (${topic}, ${partition}, ${BigInt(offset)}, ${reason})
      ON CONFLICT DO NOTHING`;
  }

  // Caller groups up to 1000 canonical, accepted telemetry events. One batched
  // source insert and hourly aggregation per month avoids a write per request.
  async recordReadings(
    tenantId: string,
    readings: readonly ReadingUsage[],
    ctx = context(),
  ): Promise<bigint> {
    if (!readings.length || readings.length > 1000)
      throw new Error("usage batch size must be 1..1000");
    const groups = new Map<string, ReadingUsage[]>();
    for (const value of readings) {
      if (!UUID.test(value.eventId) || Number.isNaN(value.acceptedAt.getTime()))
        throw new Error("invalid accepted reading event");
      const start = monthStart(value.acceptedAt).toISOString();
      groups.set(start, [...(groups.get(start) ?? []), value]);
    }
    return withTenant(this.db, tenantId, async (tx) => {
      let totalAccepted = 0n;
      // Stable order avoids lock cycles if one batch spans a month boundary.
      for (const startText of [...groups.keys()].sort((left, right) =>
        left.localeCompare(right, "en"),
      )) {
        const sourceStart = new Date(startText);
        const { start, row, late } = await lockPeriod(
          tx,
          tenantId,
          "accepted_readings",
          sourceStart,
        );
        const input = JSON.stringify(
          groups.get(startText)!.map((value) => ({
            source_id: value.eventId,
            bucket_hour: value.acceptedAt.toISOString(),
            quantity: 1,
          })),
        );
        const inserted = await tx.$queryRaw<{ quantity: bigint }[]>`
          WITH incoming AS (
            SELECT source_id::uuid AS source_id, date_trunc('hour', bucket_hour) AS bucket_hour,
              quantity FROM jsonb_to_recordset(${input}::jsonb)
              AS x(source_id text, bucket_hour timestamptz, quantity bigint)
          ), accepted AS (
            INSERT INTO usage_sources (tenant_id, meter, source_event_id,
              source_period_start, attributed_period_start, bucket_hour, quantity, late)
            SELECT ${tenantId}::uuid, 'accepted_readings', source_id,
              ${sourceStart}, ${start}, bucket_hour, quantity, ${late}
            FROM incoming ON CONFLICT DO NOTHING RETURNING bucket_hour, quantity
          ), buckets AS (
            INSERT INTO usage_ledger (tenant_id, meter, period_start, bucket_hour, quantity)
            SELECT ${tenantId}::uuid, 'accepted_readings', ${start},
              bucket_hour, sum(quantity) FROM accepted GROUP BY bucket_hour
            ON CONFLICT (tenant_id, meter, period_start, bucket_hour)
              DO UPDATE SET quantity=usage_ledger.quantity+EXCLUDED.quantity,
                version=usage_ledger.version+1
            RETURNING quantity
          ) SELECT coalesce(sum(quantity),0)::bigint AS quantity FROM accepted`;
        const count = inserted[0]?.quantity ?? 0n;
        if (!count) continue;
        const version = row.version + 1n;
        const updated = await tx.$executeRaw`UPDATE usage_periods SET
          total=total+${count}, version=${version}
          WHERE tenant_id=${tenantId}::uuid AND meter='accepted_readings'
            AND period_start=${start} AND state='open' AND version=${row.version}`;
        if (updated !== 1) throw new Error("usage period changed concurrently");
        await outbox(
          tx,
          tenantId,
          "usage_period",
          periodId(tenantId, "accepted_readings", start),
          version,
          {
            type: "usage.accepted",
            payload: {
              tenant_id: tenantId,
              meter: "accepted_readings",
              period_start: start.toISOString(),
              quantity: count.toString(),
              total: (row.total + count).toString(),
              version: version.toString(),
              late,
            },
          },
          ctx,
        );
        totalAccepted += count;
      }
      await scheduleUsage(tx, tenantId);
      return totalAccepted;
    });
  }

  // Active-device meter is a peak snapshot, not the sum of device events.
  async recordDevicePeak(
    tenantId: string,
    sourceEventId: string,
    count: number,
    at: Date,
    ctx = context(),
  ): Promise<boolean> {
    if (!UUID.test(sourceEventId) || !Number.isSafeInteger(count) || count < 0)
      throw new Error("invalid device peak sample");
    const sourceStart = monthStart(at);
    return withTenant(this.db, tenantId, async (tx) => {
      const { start, row, late } = await lockPeriod(
        tx,
        tenantId,
        "active_devices",
        sourceStart,
      );
      await scheduleUsage(tx, tenantId);
      const inserted = await tx.$executeRaw`INSERT INTO usage_sources
        (tenant_id, meter, source_event_id, source_period_start,
          attributed_period_start, bucket_hour, quantity, late)
        VALUES (${tenantId}::uuid, 'active_devices', ${sourceEventId}::uuid,
          ${sourceStart}, ${start}, ${new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours()))},
          ${BigInt(count)}, ${late}) ON CONFLICT DO NOTHING`;
      if (!inserted) return false;
      const peak = BigInt(count);
      if (peak <= row.total) return true;
      const version = row.version + 1n;
      await tx.$executeRaw`UPDATE usage_periods SET total=${peak}, version=${version}
        WHERE tenant_id=${tenantId}::uuid AND meter='active_devices'
          AND period_start=${start} AND state='open'`;
      await tx.$executeRaw`INSERT INTO usage_ledger
        (tenant_id, meter, period_start, bucket_hour, quantity)
        VALUES (${tenantId}::uuid, 'active_devices', ${start},
          ${new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours()))}, ${peak})
        ON CONFLICT (tenant_id,meter,period_start,bucket_hour)
          DO UPDATE SET quantity=GREATEST(usage_ledger.quantity, EXCLUDED.quantity),
            version=usage_ledger.version+1`;
      await outbox(
        tx,
        tenantId,
        "usage_period",
        periodId(tenantId, "active_devices", start),
        version,
        {
          type: "usage.accepted",
          payload: {
            tenant_id: tenantId,
            meter: "active_devices",
            period_start: start.toISOString(),
            quantity: peak.toString(),
            total: peak.toString(),
            version: version.toString(),
            late,
          },
        },
        ctx,
      );
      return true;
    });
  }

  async closePeriod(
    tenantId: string,
    meter: Meter,
    start: Date,
    actorId: string,
    now = new Date(),
    ctx = context(),
  ): Promise<{ total: bigint; commandId: string }> {
    const normalized = monthStart(start);
    if (normalized.getTime() !== start.getTime())
      throw new Error("period start must be UTC month start");
    const end = nextMonth(start);
    if (now < end) throw new Error("usage period has not ended");
    return withTenant(this.db, tenantId, async (tx) => {
      await tx.$executeRaw`INSERT INTO usage_periods
        (tenant_id,meter,period_start,period_end,report_idempotency_key)
        VALUES (${tenantId}::uuid,${meter},${start},${end},
          ${reportKey(tenantId, meter, start)}) ON CONFLICT DO NOTHING`;
      const actual = (
        await tx.$queryRaw<PeriodRow[]>`SELECT state,total,version,period_end
        FROM usage_periods WHERE tenant_id=${tenantId}::uuid AND meter=${meter}
          AND period_start=${start} FOR UPDATE`
      )[0]!;
      const commandId = nameId(
        "meter-report",
        tenantId,
        meter,
        start.toISOString(),
      );
      if (actual.state !== "open") {
        await scheduleUsage(tx, tenantId);
        return { total: actual.total, commandId };
      }
      const version = actual.version + 1n;
      await tx.$executeRaw`UPDATE usage_periods SET state='closed', closed_at=${now},
        version=${version} WHERE tenant_id=${tenantId}::uuid AND meter=${meter}
          AND period_start=${start} AND state='open'`;
      await tx.$executeRaw`INSERT INTO usage_reports
        (tenant_id, meter, period_start, quantity, identifier)
        VALUES (${tenantId}::uuid, ${meter}, ${start}, ${actual.total},
          ${reportKey(tenantId, meter, start)}) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO billing_commands
        (tenant_id, command_id, kind, stripe_idempotency_key, payload)
        VALUES (${tenantId}::uuid, ${commandId}::uuid, 'meter_report',
          ${reportKey(tenantId, meter, start)},
          ${JSON.stringify({
            meter,
            period_start: start.toISOString(),
            quantity: actual.total.toString(),
            event_time: meterEventTime(start, now).toISOString(),
          })}::jsonb)
        ON CONFLICT DO NOTHING`;
      await outbox(
        tx,
        tenantId,
        "billing_command",
        commandId,
        1n,
        {
          type: "billing.command_requested",
          payload: { command_id: commandId, kind: "meter_report" },
        },
        ctx,
      );
      await audit(
        tx,
        tenantId,
        actorId,
        "billing.usage.closed",
        commandId,
        {
          meter,
          period_start: start.toISOString(),
          total: actual.total.toString(),
        },
        commandId,
      );
      await scheduleUsage(tx, tenantId);
      return { total: actual.total, commandId };
    });
  }
}
