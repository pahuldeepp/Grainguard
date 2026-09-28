import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRiskEvent } from "../consumer/handler.js";
import { withTenant } from "../db/tenant.js";
import { pooledDb, newStream, riskEvent } from "../testing/fixtures.js";
import { defaultRule } from "./policy.js";
import { readRules, readTransitions, lifecycleComplete } from "./reads.js";
import { readEpisode } from "./store.js";

test("single pooled connection A → B → no-context denies leakage after commit, rollback and timeout", async () => {
  const db = pooledDb(1);
  const a = newStream(),
    b = newStream();
  try {
    const open = async (stream: ReturnType<typeof newStream>) =>
      (
        (await handleRiskEvent(db, riskEvent(stream, 75))) as {
          effect: { episodeId: string };
        }
      ).effect.episodeId;
    const idA = await open(a),
      idB = await open(b);
    const ruleA = defaultRule(a.tenantId).ruleId,
      ruleB = defaultRule(b.tenantId).ruleId;
    async function own(tenantId: string, id: string, rule: string) {
      return withTenant(
        db,
        tenantId,
        async (tx) => {
          assert.equal(
            (await readRules(tx, tenantId, [ruleA, ruleB])).length,
            1,
          );
          assert.equal((await readEpisode(tx, tenantId, id))?.episodeId, id);
          assert.equal(
            (await readTransitions(tx, tenantId, id, 50, "lifecycle")).length,
            1,
          );
          assert.equal(await lifecycleComplete(tx, tenantId, id, 1n), true);
          // Deliberately remove application tenant predicates; RLS still denies A in B and vice versa.
          const rules = await tx.$queryRaw<
            { rule_id: string }[]
          >`SELECT rule_id FROM alert_rules WHERE rule_id = ANY(${[ruleA, ruleB]}::uuid[])`;
          assert.deepEqual(
            rules.map((r) => r.rule_id),
            [rule],
          );
          const transitions = await tx.$queryRaw<
            { episode_id: string }[]
          >`SELECT episode_id FROM alert_transitions WHERE episode_id = ANY(${[idA, idB]}::uuid[])`;
          assert.deepEqual(
            transitions.map((r) => r.episode_id),
            [id],
          );
        },
        2000,
        "RepeatableRead",
      );
    }
    async function none() {
      await db.$transaction(async (tx) => {
        for (const rows of [
          await tx.$queryRaw`SELECT rule_id FROM alert_rules`,
          await tx.$queryRaw`SELECT transition_id FROM alert_transitions`,
          await tx.$queryRaw`SELECT episode_id FROM alert_episodes`,
        ])
          assert.deepEqual(rows, []);
        const [context] = await tx.$queryRaw<
          { tenant: string | null }[]
        >`SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant`;
        assert.equal(context.tenant, null);
      });
    }
    const cycle = async () => {
      await own(a.tenantId, idA, ruleA);
      await own(b.tenantId, idB, ruleB);
      await none();
    };
    await cycle();
    await assert.rejects(
      withTenant(db, a.tenantId, async (tx) => {
        await readRules(tx, a.tenantId, [ruleA]);
        await readTransitions(tx, a.tenantId, idA, 50, "all");
        throw new Error("forced rollback");
      }),
      /forced rollback/,
    );
    await cycle();
    await assert.rejects(
      withTenant(db, a.tenantId, async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', '20ms', true)`;
        await tx.$queryRaw`SELECT pg_sleep(0.1)`;
      }),
    );
    await cycle();
    await withTenant(db, b.tenantId, async (tx) => {
      assert.deepEqual(await readRules(tx, b.tenantId, [ruleA]), []);
      assert.deepEqual(
        await readTransitions(tx, b.tenantId, idA, 50, "all"),
        [],
      );
      assert.equal(await lifecycleComplete(tx, b.tenantId, idA, 1n), false);
      assert.equal(await readEpisode(tx, b.tenantId, idA), undefined);
    });
  } finally {
    await db.$disconnect();
  }
});
