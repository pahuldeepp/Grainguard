# Stage 08 browser E2E

Run: 2026-09-25T16:29:32.224Z
Result: FAIL
Duration: 262 seconds

## Checks

- PASS saga API accepts a real Dex bearer and resolves GreenGuard membership :: HTTP 404 for an unknown saga
- PASS gateway accepts the Dex bearer and forwards GraphQL to the BFF :: HTTP 200 tenant=0a0a0a0a-0000-4000-8000-00000000000a
- PASS gateway rejects an anonymous GraphQL request :: HTTP 401
- PASS S1 alice login used auth code + PKCE S256 with state and nonce :: response_type=code method=S256
- PASS S1 UI start sends an Idempotency-Key and gets a saga :: key=a4befc1b… saga=af16c355-8efa-4f23-a114-e122e0bcb33a state=reserving errors=null
- PASS S1 UI polls durable status to active :: badges seen=[reserving -> active] history=[provisioning.requested, asset.reserved, asset.configured, inventory.activated, binding.ready]
- PASS S2 reload mid-provisioning restores the tracked saga after sign-in :: before=reserving signInRequired=true url=/provisioning?saga=c3c44926-776d-4d15-82b2-6df2c848d58a restoredState=reserving
- PASS S2 repeated Start after reconnect reuses the saga (no second saga) :: firstKey=663e27f1 secondKey=663e27f1 second=c3c44926-776d-4d15-82b2-6df2c848d58a sagasForDevice=1
- PASS S2 reconnected UI reaches active :: badges seen=[reserving -> configuring -> active]
- PASS S5 bob (operator, tenant B) starts own provisioning through BFF :: saga=f2e4ff16-9343-46cb-b48c-a0922e5dec78 err=null
- PASS S3 participant down renders pending -> compensating -> repair required with admin redrive :: seen=[reserving -> reserving -> compensating -> compensating -> repair required] redriveButton=true
- PASS S3 viewer cannot redrive (API) :: code=insufficient_role
- PASS S3 admin redrive through UI completes compensation :: seen=[repair required -> compensating -> compensated] history=[provisioning.requested, deadline.compensate, deadline.expired, operator.replay, late_result.reconciled, asset.released]
- PASS S4 device-token ingest accepted hot and 48h-old readings :: hot=202 reading=12a6ae16-83f8-46f4-a14a-c65b57640ffa cold=202 {"status":"stored","reading_id":"dfa1046a-f7c5-44c0-93d1-66c1cb5e8d2d","event_id":"5763c3cb-d0b8-47f6-ae09-458fbc98e2c2"

## Failures

- harness: Elasticsearch indexed the device timed out: no match
