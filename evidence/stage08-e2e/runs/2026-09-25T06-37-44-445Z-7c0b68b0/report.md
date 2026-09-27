# Stage 08 browser E2E

Run: 2026-09-25T06:37:44.479Z
Result: PASS
Duration: 101 seconds

## Checks

- PASS saga API accepts a real Dex bearer and resolves GreenGuard membership :: HTTP 404 for an unknown saga
- PASS S1 alice login used auth code + PKCE S256 with state and nonce :: response_type=code method=S256
- PASS S1 UI start sends an Idempotency-Key and gets a saga :: key=4c666378… saga=c7e0d055-06a8-4480-93f6-67f4a48be9cc state=reserving errors=null
- PASS S1 UI polls durable status to active :: badges seen=[reserving -> active] history=[provisioning.requested, asset.reserved, asset.configured, inventory.activated, binding.ready]
- PASS S2 reload mid-provisioning restores the tracked saga after sign-in :: before=reserving signInRequired=true url=/provisioning?saga=9a78a1c2-898d-4e4f-82d2-a30ac614a4c9 restoredState=configuring
- PASS S2 repeated Start after reconnect reuses the saga (no second saga) :: firstKey=18ba4aef secondKey=18ba4aef second=9a78a1c2-898d-4e4f-82d2-a30ac614a4c9 sagasForDevice=1
- PASS S2 reconnected UI reaches active :: badges seen=[configuring -> active]
- PASS S5 bob (operator, tenant B) starts own provisioning through BFF :: saga=71990583-0602-4ea8-a5bf-b28a524a12b0 err=null
- PASS S3 participant down renders pending -> compensating -> repair required with admin redrive :: seen=[reserving -> reserving -> compensating -> compensating -> repair required] redriveButton=true
- PASS S3 viewer cannot redrive (API) :: code=insufficient_role
- PASS S3 admin redrive through UI completes compensation :: seen=[repair required -> compensating -> compensated] history=[provisioning.requested, deadline.compensate, deadline.expired, operator.replay, late_result.reconciled, asset.released]
- PASS S4 device-token ingest accepted hot and 48h-old readings :: hot=202 reading=f498233b-12ef-4adc-801e-22a834476078 cold=202 {"status":"stored","reading_id":"37ff626f-d422-4dcc-9a07-0f16aeae6706","event_id":"1bd88034-aa07-43ef-83eb-17a129d62927"
- PASS S4 UI search (Elasticsearch via BFF/Read API) finds the device :: serial=bre2e-4f3761f5-main
- PASS S4 UI current/latest reading from the read DB :: row contains 18.25 °C / 61.5 %: true
- PASS S4 UI recent history (default 12 h, Postgres hot window) :: rows=1
- PASS S4 UI older range served from Cassandra :: ui has 48h-old 12.5 °C=true readApi source=cassandra rows=2
- PASS S5 bob search cannot see tenant A device :: query=bre2e-4f3761f5-main
- PASS S5 bob GraphQL cannot read A's device, readings, saga or redrive :: device=null latest=null history=0 saga=not_found redrive=insufficient_role
- PASS S5 bob opening A's device URL sees not-found :: url=/devices/5ef81612-82a2-4ff6-89f8-2d875c00844f
- PASS S5 bob opening A's saga URL gets an error, no status :: alert="not_found"
- PASS S5 viewer cannot start provisioning (UI hides/disables, API rejects) :: startVisible=false startEnabled=false api=insufficient_role
- PASS S5 bob still reads own tenant saga :: state=active
- PASS S6 accessibility smoke: zero serious/critical findings :: pages=sign-in,home,provisioning,devices blocking=[] other=[]
- PASS S7 loading state is announced (role=status) :: status="Searching devices…"
- PASS S7 Read API down: read views show an error, provisioning still works (partial) :: searchAlert="Device data is temporarily unavailable. Try again shortly." provisioningState=active
- PASS S7 recovery: read views return after the Read API is reachable :: search hit=true
