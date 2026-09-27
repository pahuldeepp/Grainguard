# Stage 08 browser E2E

Run: 2026-09-25T16:17:52.446Z
Result: FAIL
Duration: 220 seconds

## Checks

- PASS saga API accepts a real Dex bearer and resolves GreenGuard membership :: HTTP 404 for an unknown saga
- PASS gateway accepts the Dex bearer and forwards GraphQL to the BFF :: HTTP 200 tenant=0a0a0a0a-0000-4000-8000-00000000000a
- PASS gateway rejects an anonymous GraphQL request :: HTTP 401
- PASS S1 alice login used auth code + PKCE S256 with state and nonce :: response_type=code method=S256
- PASS S1 UI start sends an Idempotency-Key and gets a saga :: key=1718d5d2… saga=b89e72a4-5797-4d54-822e-a6e3584c8f62 state=reserving errors=null
- PASS S1 UI polls durable status to active :: badges seen=[reserving -> configuring -> active] history=[provisioning.requested, asset.reserved, asset.configured, inventory.activated, binding.ready]
- PASS S2 reload mid-provisioning restores the tracked saga after sign-in :: before=reserving signInRequired=true url=/provisioning?saga=2d479f2f-b0e7-42d4-af46-a4116e60831c restoredState=configuring
- PASS S2 repeated Start after reconnect reuses the saga (no second saga) :: firstKey=58f06aa2 secondKey=58f06aa2 second=2d479f2f-b0e7-42d4-af46-a4116e60831c sagasForDevice=1
- PASS S2 reconnected UI reaches active :: badges seen=[configuring -> active]
- PASS S5 bob (operator, tenant B) starts own provisioning through BFF :: saga=ad150a3c-30ed-4ec7-8655-86434310d767 err=null
- PASS S3 participant down renders pending -> compensating -> repair required with admin redrive :: seen=[reserving -> reserving -> compensating -> compensating -> repair required] redriveButton=true
- PASS S3 viewer cannot redrive (API) :: code=insufficient_role
- PASS S3 admin redrive through UI completes compensation :: seen=[repair required -> compensating -> compensated] history=[provisioning.requested, deadline.compensate, deadline.expired, operator.replay, late_result.reconciled, asset.released]
- PASS S4 device-token ingest accepted hot and 48h-old readings :: hot=202 reading=deb44d91-b449-4db2-806b-19f1ef0bf949 cold=202 {"status":"stored","reading_id":"637e9c8d-dc97-4e13-9197-07875d045afc","event_id":"8c39934e-e2b2-4c85-9166-55202a2ec9d2"
- PASS S4 UI search (Elasticsearch via BFF/Read API) finds the device :: serial=bre2e-aa7444e5-main
- PASS S4 UI current/latest reading from the read DB :: row contains 18.25 °C / 61.5 %: true
- PASS S4 UI recent history (default 12 h, Postgres hot window) :: rows=1
- PASS S4 UI older range served from Cassandra :: ui has 48h-old 12.5 °C=true readApi source=cassandra rows=2
- PASS S8 alert list is tenant scoped and viewer cannot acknowledge :: listed=true bobItems=0 viewer=insufficient_role

## Failures

- harness: locator.click: Error: strict mode violation: getByRole('button', { name: 'Acknowledge' }) resolved to 2 elements:
    1) <button type="button" class="chakra-button css-kcj133">Acknowledge</button> aka getByRole('listitem').filter({ hasText: 'critical · Bin 11be23c0-f5d1-' }).getByRole('button')
    2) <button type="button" class="chakra-button css-kcj133">Acknowledge</button> aka getByRole('listitem').filter({ hasText: 'critical · Bin 5d3608ce-c258-' }).getByRole('button')

Call log:
[2m  - waiting for getByRole('button', { name: 'Acknowledge' })[22m

