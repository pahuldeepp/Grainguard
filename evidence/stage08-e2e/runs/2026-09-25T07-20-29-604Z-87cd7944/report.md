# Stage 08 browser E2E

Run: 2026-09-25T07:20:29.653Z
Result: PASS
Duration: 100 seconds

## Checks

- PASS saga API accepts a real Dex bearer and resolves GreenGuard membership :: HTTP 404 for an unknown saga
- PASS S1 alice login used auth code + PKCE S256 with state and nonce :: response_type=code method=S256
- PASS S1 UI start sends an Idempotency-Key and gets a saga :: key=c4c8af4e… saga=a1ca86a9-82df-4131-801d-4b0171460b12 state=reserving errors=null
- PASS S1 UI polls durable status to active :: badges seen=[reserving -> active] history=[provisioning.requested, asset.reserved, asset.configured, inventory.activated, binding.ready]
- PASS S2 reload mid-provisioning restores the tracked saga after sign-in :: before=reserving signInRequired=true url=/provisioning?saga=252a5ed1-7070-4065-aa78-609c24c5bb2d restoredState=configuring
- PASS S2 repeated Start after reconnect reuses the saga (no second saga) :: firstKey=45a5cbae secondKey=45a5cbae second=252a5ed1-7070-4065-aa78-609c24c5bb2d sagasForDevice=1
- PASS S2 reconnected UI reaches active :: badges seen=[configuring -> active]
- PASS S5 bob (operator, tenant B) starts own provisioning through BFF :: saga=97e4dcc6-b777-43bb-a0fd-fd78f712a63d err=null
- PASS S3 participant down renders pending -> compensating -> repair required with admin redrive :: seen=[reserving -> reserving -> compensating -> compensating -> repair required] redriveButton=true
- PASS S3 viewer cannot redrive (API) :: code=insufficient_role
- PASS S3 admin redrive through UI completes compensation :: seen=[repair required -> compensating -> compensated] history=[provisioning.requested, deadline.compensate, deadline.expired, operator.replay, late_result.reconciled, asset.released]
- PASS S4 device-token ingest accepted hot and 48h-old readings :: hot=202 reading=3de3381d-1a23-4dc5-8142-25361f40ee1c cold=202 {"status":"stored","reading_id":"a210a2ae-ce47-46b8-a051-30fadd5e1513","event_id":"e9abcee5-5a4d-4473-8ff3-061111b738a4"
- PASS S4 UI search (Elasticsearch via BFF/Read API) finds the device :: serial=bre2e-fdbd25ab-main
- PASS S4 UI current/latest reading from the read DB :: row contains 18.25 °C / 61.5 %: true
- PASS S4 UI recent history (default 12 h, Postgres hot window) :: rows=1
- PASS S4 UI older range served from Cassandra :: ui has 48h-old 12.5 °C=true readApi source=cassandra rows=2
- PASS S5 bob search cannot see tenant A device :: query=bre2e-fdbd25ab-main
- PASS S5 bob GraphQL cannot read A's device, readings, saga or redrive :: device=null latest=null history=0 saga=not_found redrive=insufficient_role
- PASS S5 bob opening A's device URL sees not-found :: url=/devices/aa8da730-05af-4681-8bfc-3a4323ab4bf1
- PASS S5 bob opening A's saga URL gets an error, no status :: alert="not_found"
- PASS S5 viewer cannot start provisioning (UI hides/disables, API rejects) :: startVisible=false startEnabled=false api=insufficient_role
- PASS S5 bob still reads own tenant saga :: state=active
- PASS S6 accessibility smoke: zero serious/critical findings :: pages=sign-in,home,provisioning,devices blocking=[] other=[]
- PASS S7 loading state is announced (role=status) :: status="Searching devices…"
- PASS S7 Read API down: read views show an error, provisioning still works (partial) :: searchAlert="Device data is temporarily unavailable. Try again shortly." provisioningState=active
- PASS S7 recovery: read views return after the Read API is reachable :: search hit=true
