# Mobile data availability: live evidence (2026-09-26)

Read-only probe. User `alice@greenguard.test` (tenant `0a0a0a0a…`, role admin, subject truncated to a Dex id)
logged in through `scripts/oidc-login.mjs` (auth code + PKCE against Dex 127.0.0.1:5556); the token lived only
inside one Node process and was never printed. Requests used the BFF persisted-query hashes from
`services/bff/src/query-policy.ts`. Ids below are truncated to 8 characters.

## What was running
| Service | Address | Result |
| --- | --- | --- |
| Dex | 127.0.0.1:5556 | login OK |
| BFF | 127.0.0.1:4400 | answered all alert operations |
| workflow-alerts | 127.0.0.1:4405 | answered `/v1/alerts` |
| Read API | 127.0.0.1:4401 | NOT listening (connection refused); BFF returned `read_api_unavailable` for every device/reading query |

Consequence: latest reading, history, rollups, site devices and device search could NOT be verified live.
Their shapes below come from source only.

## Live responses (redacted shapes)
`session` -> 200 `{session:{subject:string, tenantId:"0a0a0a0a…", roles:["admin"]}}`

`alertList` (limit 100, no state) -> 200, 11 items, `nextCursor:null`:
`{alertId:uuid, ruleId:uuid, binId:uuid, state:"acknowledged"|"open", severity:"critical", score:number(87), version:"2" (string), openedAt:ISO, acknowledgedAt:ISO|null, escalationLevel:number(0)}`
- state=open -> 4 items; state=acknowledged -> 7; state=resolved -> 0 (empty page).
- 11 alerts, 11 distinct `binId`s, all severity `critical`, all `escalationLevel` 0.

`alertDetail` -> 200: same fields plus `acknowledgedBy: string` (the acknowledging user's Dex subject, an opaque id, not a name/email).

`workflow-alerts GET /v1/alerts?limit=1` (direct) -> 200 adds `openWindowStart`, `acknowledgedBy`, `resolvedAt` (null) to each item; `nextCursor` is the last alert id when the page is full.
`GET /v1/alerts/<id>/transitions` -> 404; `/history` -> 404 (no such routes).

Negative checks:
- Ad-hoc (non-persisted) GraphQL query -> 400 `persisted_operation_required`. A client cannot add fields itself; every new field needs a new persisted operation in `query-policy.ts` (mobile copy must stay byte-identical).
- `deviceSearch(query=<binId>)` -> 200 with no usable data (Read API down).
- No bin or site name appears in any alert response.
