# Stage 08 browser E2E

Run: 2026-09-25T16:27:25.022Z
Result: FAIL
Duration: 103 seconds

## Checks

- PASS saga API accepts a real Dex bearer and resolves GreenGuard membership :: HTTP 404 for an unknown saga
- PASS gateway accepts the Dex bearer and forwards GraphQL to the BFF :: HTTP 200 tenant=0a0a0a0a-0000-4000-8000-00000000000a
- PASS gateway rejects an anonymous GraphQL request :: HTTP 401
- PASS S1 alice login used auth code + PKCE S256 with state and nonce :: response_type=code method=S256
- PASS S1 UI start sends an Idempotency-Key and gets a saga :: key=c7ec235c… saga=8cb139c3-d20a-4123-b6c4-9cfe01ae4518 state=reserving errors=null
- PASS S1 UI polls durable status to active :: badges seen=[reserving -> active] history=[provisioning.requested, asset.reserved, asset.configured, inventory.activated, binding.ready]
- PASS S2 reload mid-provisioning restores the tracked saga after sign-in :: before=reserving signInRequired=true url=/provisioning?saga=b6a84e66-9c00-49d5-964c-9298d688c9dc restoredState=configuring
- PASS S2 repeated Start after reconnect reuses the saga (no second saga) :: firstKey=06aae0b0 secondKey=06aae0b0 second=b6a84e66-9c00-49d5-964c-9298d688c9dc sagasForDevice=1
- PASS S2 reconnected UI reaches active :: badges seen=[configuring -> active]
- PASS S5 bob (operator, tenant B) starts own provisioning through BFF :: saga=6161f7c5-58de-44c5-87a4-0b0455cfa18b err=null
- PASS S3 participant down renders pending -> compensating -> repair required with admin redrive :: seen=[reserving -> reserving -> compensating -> compensating -> repair required] redriveButton=true
- PASS S3 viewer cannot redrive (API) :: code=insufficient_role
- PASS S3 admin redrive through UI completes compensation :: seen=[repair required -> compensating -> compensated] history=[provisioning.requested, deadline.compensate, deadline.expired, operator.replay, late_result.reconciled, asset.released]
- PASS S4 device-token ingest accepted hot and 48h-old readings :: hot=202 reading=995c638d-45d9-4257-932f-81269e5414a8 cold=202 {"status":"stored","reading_id":"34609207-2be9-40cc-97b1-163670949890","event_id":"e4fc51bf-eb3e-4fae-9815-1f64f21002e7"
- PASS S4 UI search (Elasticsearch via BFF/Read API) finds the device :: serial=bre2e-19599577-main
- PASS S4 browser subscription uses ticket handshake and reconnects :: firstAck=true reconnected=true
- PASS S4 UI current/latest reading from the read DB :: row contains 18.25 °C / 61.5 %: true
- PASS S4 UI recent history (default 12 h, Postgres hot window) :: rows=1
- PASS S4 UI older range served from Cassandra :: ui has 48h-old 12.5 °C=true readApi source=cassandra rows=2
- PASS S8 alert list is tenant scoped and viewer cannot acknowledge :: listed=true bobItems=0 viewer=insufficient_role
- PASS S8 admin acknowledges an alert through the gateway and UI refreshes :: openViewRemoved=true acknowledgedView=true responses=[{"status":200,"items":["3e070f9a-ebff-44d9-a040-2aa29888e3da","56ac6df2-e261-4f79-82cf-c4a79ca9b386","81069c5e-c6e1-4909-8978-02edd6656211"]},{"status":200,"ack":"acknowledged"},{"status":200,"items":["3e070f9a-ebff-44d9-a040-2aa29888e3da","81069c5e-c6e1-4909-8978-02edd6656211"]},{"status":200,"items":["56ac6df2-e261-4f79-82cf-c4a79ca9b386","98562496-227b-4779-b0c6-54c0eb5538c6"]}]
- PASS S5 bob search cannot see tenant A device :: query=bre2e-19599577-main
- PASS S5 bob GraphQL cannot read A's device, readings, saga or redrive :: device=null latest=null history=0 saga=not_found redrive=insufficient_role
- PASS S5 bob opening A's device URL sees not-found :: url=/devices/4e6fc55f-44dc-4c22-9d9c-27a2d25ade23
- PASS S5 bob opening A's saga URL gets an error, no status :: alert="not_found"
- PASS S5 viewer cannot start provisioning (UI hides/disables, API rejects) :: startVisible=false startEnabled=false api=insufficient_role
- PASS S5 bob still reads own tenant saga :: state=active

## Failures

- harness: locator.click: Error: strict mode violation: getByRole('link', { name: 'Devices' }) resolved to 2 elements:
    1) <a href="/devices" data-discover="true">Devices</a> aka getByRole('link', { name: 'Devices', exact: true })
    2) <a class="outline" href="/devices" data-discover="true">Browse devices</a> aka getByRole('link', { name: 'Browse devices' })

Call log:
[2m  - waiting for getByRole('link', { name: 'Devices' })[22m

