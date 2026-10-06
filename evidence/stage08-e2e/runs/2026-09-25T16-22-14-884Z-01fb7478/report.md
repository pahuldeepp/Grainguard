# Stage 08 browser E2E

Run: 2026-09-25T16:22:14.898Z
Result: FAIL
Duration: 107 seconds

## Checks

- PASS saga API accepts a real Dex bearer and resolves GreenGuard membership :: HTTP 404 for an unknown saga
- PASS gateway accepts the Dex bearer and forwards GraphQL to the BFF :: HTTP 200 tenant=0a0a0a0a-0000-4000-8000-00000000000a
- PASS gateway rejects an anonymous GraphQL request :: HTTP 401
- PASS S1 alice login used auth code + PKCE S256 with state and nonce :: response_type=code method=S256
- PASS S1 UI start sends an Idempotency-Key and gets a saga :: key=b364d7a0… saga=584f16bc-2c11-4067-934b-ee175e27422e state=reserving errors=null
- PASS S1 UI polls durable status to active :: badges seen=[reserving -> active] history=[provisioning.requested, asset.reserved, asset.configured, inventory.activated, binding.ready]
- PASS S2 reload mid-provisioning restores the tracked saga after sign-in :: before=reserving signInRequired=true url=/provisioning?saga=846e5fda-039c-4dea-8821-f03b2a1df596 restoredState=configuring
- PASS S2 repeated Start after reconnect reuses the saga (no second saga) :: firstKey=2220955b secondKey=2220955b second=846e5fda-039c-4dea-8821-f03b2a1df596 sagasForDevice=1
- PASS S2 reconnected UI reaches active :: badges seen=[configuring -> active]
- PASS S5 bob (operator, tenant B) starts own provisioning through BFF :: saga=928302c1-a2df-43a2-8974-45c0557a4a9a err=null
- PASS S3 participant down renders pending -> compensating -> repair required with admin redrive :: seen=[reserving -> reserving -> compensating -> compensating -> repair required] redriveButton=true
- PASS S3 viewer cannot redrive (API) :: code=insufficient_role
- PASS S3 admin redrive through UI completes compensation :: seen=[repair required -> compensating -> compensated] history=[provisioning.requested, deadline.compensate, deadline.expired, operator.replay, late_result.reconciled, asset.released]
- PASS S4 device-token ingest accepted hot and 48h-old readings :: hot=202 reading=e1b9af41-72a2-4154-b69f-47302dd7f720 cold=202 {"status":"stored","reading_id":"9d5d5f3e-25b2-47bc-be37-bdc296f8b6bf","event_id":"5f96225e-8a20-4957-9022-f0ab747a33ee"
- PASS S4 UI search (Elasticsearch via BFF/Read API) finds the device :: serial=bre2e-f154255a-main
- PASS S4 browser subscription uses ticket handshake and reconnects :: firstAck=true reconnected=true
- PASS S4 UI current/latest reading from the read DB :: row contains 18.25 °C / 61.5 %: true
- PASS S4 UI recent history (default 12 h, Postgres hot window) :: rows=1
- PASS S4 UI older range served from Cassandra :: ui has 48h-old 12.5 °C=true readApi source=cassandra rows=2
- PASS S8 alert list is tenant scoped and viewer cannot acknowledge :: listed=true bobItems=0 viewer=insufficient_role

## Failures

- harness: locator.waitFor: Timeout 15000ms exceeded.
Call log:
[2m  - waiting for getByRole('listitem').filter({ hasText: '10a602a0-9e24-4a85-8ce0-287ce3a2cc5c' }) to be hidden[22m
[2m    34 × locator resolved to visible <li>…</li>[22m

