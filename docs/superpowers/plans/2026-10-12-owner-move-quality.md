# Tenant-move owner duplication closure

## Spec

The strict repository quality gate still has unrelated findings after the first quality wave. Remove duplicated tenant-move owner orchestration through cohesive shared internal helpers while preserving exact security, transaction, outbox, placement and migration behavior.

## Global constraints

- Work only in the assigned isolated worktree. No commits, pushes, AWS, private credentials, shared database/stack mutations or subagents.
- No suppressions, exclusions, reduced quality thresholds, behavior changes, SQL alterations, relaxed receipts/fences or historic migration edits.
- Preserve owner-specific error text, procedure parameters/order, schema inventories, owner identities, epochs, transaction boundaries and retry semantics.
- Record precise unit coverage and unavailable live checks. Independent review and integrated verification precede acceptance.

## Task 1: Shared owner-move adapters

Own services/tenant-control-plane/src/tenant-move only. Inspect inventory-owner.ts, telemetry-owner.ts and risk-owner.ts, their tests and existing pg-owner.ts helpers. Current Sonar duplication identifies large repeated validation/receipt/procedure orchestration regions in these adapters. Extract only genuinely identical operations into a reviewed internal helper/factory with finite typed owner identities and static SQL, leaving each owner's different tables and guard logic explicit. Do not accept arbitrary owner/table/procedure names or mix source/target owner roles. Preserve every call, parameter, validation and error contract. Add differential/negative tests for receipt identity, malformed epochs, wrong owner/shard/tenant/incarnation, preflight failure and call ordering. Run covering control-plane unit tests, lint/typecheck and CodeRabbit in the isolated worktree; report live database skips. Return complete incremental patch and addressed duplication evidence without claiming the global gate is green.
