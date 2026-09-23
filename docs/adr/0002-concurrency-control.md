# ADR-0002: choosing optimistic or pessimistic concurrency control

Status: accepted, 2026-09-23 (Stage 02a).

Contended state must use an explicit, tested concurrency strategy. Choose per operation:

| Situation                                                                                                                                     | Strategy                                     | Mechanism                                                                                                                 | Failure result                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A client edits state it previously read (UI or API edit of device binding)                                                                    | Optimistic                                   | `version` column in the `WHERE`; increment on success (`changeDeviceBinding`)                                             | `VersionConflictError` with the current version → HTTP 409             |
| A server-side command changes a row without a client-supplied version, or a read-modify-write on one hot row (status change, stream sequence) | Pessimistic                                  | `SELECT ... FOR UPDATE` in the same transaction (`lockDevice`, `setDeviceStatus`), always with `lock_timeout` or `NOWAIT` | `LockNotAvailableError` (SQLSTATE 55P03) → HTTP 409/503, safe to retry |
| Concurrent retries of one idempotent command                                                                                                  | Pessimistic, keyed                           | `pg_advisory_xact_lock` on tenant + command + idempotency key, then read the receipt                                      | Retries queue and return the stored result                             |
| Invariants across rows or aggregates (quotas, capacity, billing)                                                                              | Serializable, or `FOR UPDATE` on a guard row | `isolationLevel: "Serializable"` with bounded retry on 40001                                                              | Retry, then 409                                                        |

Rules:

- Never wait without a bound: pessimistic locks set `lock_timeout` (default 2 s) or use `NOWAIT`.
- Keep one lock order in every code path that takes more than one lock (for example stream row, then binding).
- Only transaction-scoped locks and settings are allowed (`FOR UPDATE`, `pg_advisory_xact_lock`, `set_config(..., true)`). Session-level locks and `SET` break under PgBouncer transaction pooling.
- Prisma has no `FOR UPDATE` API: use `$queryRaw` inside the same interactive `$transaction` that set the tenant context, and keep an explicit `tenant_id` filter in the SQL in addition to RLS.
- Every strategy has a contention test (see `services/device-service/src/inventory/repository.test.ts`).
