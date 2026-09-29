#!/usr/bin/env node
// Recomputes docs/intelligence/cost_model.json and fails on any cap breach or arithmetic drift.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = process.argv[2] ?? join(root, "docs/intelligence/cost_model.json");
const model = JSON.parse(readFileSync(path, "utf8"));
const errors = [];
const fail = (msg) => errors.push(msg);
const cents = (x) => Math.round(x * 100 + 1e-9) / 100;
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const usd = (x) => `$${x.toFixed(2)}`;

const { caps } = model;
if (
  caps.infrastructure + caps.product_claude + caps.eval_claude !==
  caps.total
) {
  fail(
    `caps do not add up: ${caps.infrastructure}+${caps.product_claude}+${caps.eval_claude} != ${caps.total}`,
  );
}

// Infrastructure lines
const seen = new Set();
const lineCost = (l, qty = l.quantity, price = l.unit_price) =>
  cents(price * qty);
for (const l of model.lean_lines) {
  if (seen.has(l.id)) fail(`duplicate line id ${l.id}`);
  seen.add(l.id);
  if (!near(lineCost(l), l.monthly_usd, 0.011)) {
    fail(
      `line ${l.id}: ${l.unit_price} x ${l.quantity} = ${lineCost(l)} but monthly_usd is ${l.monthly_usd}`,
    );
  }
  if (typeof l.verified !== "boolean" || !l.price_source || !l.date)
    fail(`line ${l.id}: needs verified, price_source, date`);
  if (l.verified && l.source_kind === "memory")
    fail(`line ${l.id}: memory-sourced price cannot be verified`);
}
const infra = cents(sum(model.lean_lines.map((l) => l.monthly_usd)));
if (!near(infra, model.lean_infrastructure_subtotal, 0.011)) {
  fail(
    `infrastructure lines sum to ${infra}, file says ${model.lean_infrastructure_subtotal}`,
  );
}

// Scenarios
const scenarios = [];
for (const s of model.scenarios ?? []) {
  const total = cents(
    sum(
      model.lean_lines.map((l) =>
        lineCost(
          l,
          s.overrides?.[l.id] ?? l.quantity,
          s.price_overrides?.[l.id] ?? l.unit_price,
        ),
      ),
    ),
  );
  scenarios.push([s.id, total, s.must_be_within_cap]);
  if (s.must_be_within_cap && total > caps.infrastructure)
    fail(
      `scenario ${s.id}: ${total} exceeds infrastructure cap ${caps.infrastructure}`,
    );
}

// Claude caps
const product = sum(Object.values(model.claude_product.split));
const evalSum = sum(Object.values(model.claude_eval.split));
if (product !== model.claude_product.cap)
  fail(`product split sums to ${product}, cap ${model.claude_product.cap}`);
if (evalSum !== model.claude_eval.cap)
  fail(`eval split sums to ${evalSum}, cap ${model.claude_eval.cap}`);

// Call-type prices
const ct = model.claude_call_types;
const k = ct.tokens_k;
const rate = ct.models_per_mtok;
const price = (m, inK, outK, cacheK = 0) =>
  (inK * rate[m].in + outK * rate[m].out + cacheK * rate[m].cache_read) / 1000;
const weighted = { uncached: 0, warm: 0 };
for (const m of Object.keys(rate)) {
  const router = price(ct.router_model, k.router.in, k.router.out);
  const plan = price(m, k.plan.in, k.plan.out);
  const answer = price(m, k.answer.in, k.answer.out);
  const planW = price(
    m,
    k.plan.fresh_in_warm,
    k.plan.out,
    k.plan.cache_read_warm,
  );
  const answerW = price(
    m,
    k.answer.fresh_in_warm,
    k.answer.out,
    k.answer.cache_read_warm,
  );
  const q = router + plan + answer;
  const qw = router + planW + answerW;
  if (!near(q, ct.question_uncached_usd[m], 0.00006))
    fail(
      `${m} uncached question ${q.toFixed(5)} != ${ct.question_uncached_usd[m]}`,
    );
  if (!near(qw, ct.question_warm_usd[m], 0.00006))
    fail(`${m} warm question ${qw.toFixed(5)} != ${ct.question_warm_usd[m]}`);
  weighted.uncached += ct.route_weights[m] * q;
  weighted.warm += ct.route_weights[m] * qw;
}
if (!near(weighted.uncached, ct.weighted_question_uncached_usd, 0.0001))
  fail(
    `weighted uncached ${weighted.uncached.toFixed(5)} != ${ct.weighted_question_uncached_usd}`,
  );
if (!near(weighted.warm, ct.weighted_question_warm_target_usd, 0.0001))
  fail(
    `weighted warm ${weighted.warm.toFixed(5)} != ${ct.weighted_question_warm_target_usd}`,
  );
if (!near(sum(Object.values(ct.route_weights)), 1, 1e-9))
  fail("route weights do not sum to 1");

// Free-plan default
const fp = model.free_plan_default;
const worst =
  fp.demo_tenants *
  fp.advisor_turns_per_tenant_per_day *
  fp.days *
  fp.cost_per_question_usd;
if (
  fp.per_tenant_daily_budget_usd <
  fp.advisor_turns_per_tenant_per_day * fp.cost_per_question_usd
)
  fail("per-tenant daily budget is below turns x cost per question");
if (worst > fp.customer_traffic_budget_usd)
  fail(
    `free-plan worst case ${worst.toFixed(2)} exceeds customer traffic budget ${fp.customer_traffic_budget_usd}`,
  );
if (
  fp.customer_traffic_budget_usd !== model.claude_product.split.customer_traffic
)
  fail("free-plan customer traffic budget differs from the product split");
if (fp.cost_per_question_usd !== ct.question_uncached_usd.haiku_4_5)
  fail("free-plan cost per question differs from the Haiku uncached question");

// Totals and caps
const grand = cents(infra + product + evalSum);
const headroom = cents(caps.total - grand);
if (!near(grand, model.grand_total_at_caps, 0.011))
  fail(`grand total ${grand} != file ${model.grand_total_at_caps}`);
if (!near(headroom, model.headroom_usd, 0.011))
  fail(`headroom ${headroom} != file ${model.headroom_usd}`);
if (infra > caps.infrastructure)
  fail(`infrastructure ${infra} > cap ${caps.infrastructure}`);
if (product > caps.product_claude)
  fail(`product Claude ${product} > cap ${caps.product_claude}`);
if (evalSum > caps.eval_claude)
  fail(`eval Claude ${evalSum} > cap ${caps.eval_claude}`);
if (grand > caps.total) fail(`grand total ${grand} > cap ${caps.total}`);
if (model.headroom_target_usd < 50)
  fail(
    `headroom target ${model.headroom_target_usd} is below the owner-accepted floor of 50 (ADR-0029)`,
  );
if (headroom < model.headroom_target_usd)
  fail(`headroom ${headroom} < target ${model.headroom_target_usd}`);

const unverified = model.lean_lines.filter((l) => !l.verified);
console.log("GreenGuard Intelligence cost check");
console.log(
  `  infrastructure   ${usd(infra)} (cap ${caps.infrastructure}, ${model.lean_lines.length} lines)`,
);
console.log(`  product Claude   ${usd(product)} (cap ${caps.product_claude})`);
console.log(`  eval Claude      ${usd(evalSum)} (cap ${caps.eval_claude})`);
console.log(
  `  grand total      ${usd(grand)} (cap ${caps.total}), headroom ${usd(headroom)} (target ${model.headroom_target_usd})`,
);
for (const [id, total, must] of scenarios)
  console.log(
    `  scenario ${id}: ${usd(total)}${must ? "" : " (informational, may exceed cap)"}`,
  );
console.log(
  `  weighted question uncached ${weighted.uncached.toFixed(4)}, warm ${weighted.warm.toFixed(4)}; free-plan worst case ${usd(worst)}`,
);
console.log(
  `  unverified lines: ${unverified.map((l) => `${l.id} ${usd(l.monthly_usd)}`).join(", ") || "none"}`,
);
if (errors.length) {
  console.error(`FAILED (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("OK");
