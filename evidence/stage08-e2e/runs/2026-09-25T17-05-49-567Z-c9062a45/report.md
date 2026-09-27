# Stage 08 browser E2E

Run: 2026-09-25T17:05:49.603Z
Result: PASS
Duration: 108 seconds

## Checks

- PASS saga API accepts a real Dex bearer and resolves GreenGuard membership :: HTTP 404 for an unknown saga
- PASS gateway accepts the Dex bearer and forwards GraphQL to the BFF :: HTTP 200 tenant=0a0a0a0a-0000-4000-8000-00000000000a
- PASS gateway rejects an anonymous GraphQL request :: HTTP 401
- PASS S1 alice login used auth code + PKCE S256 with state and nonce :: response_type=code method=S256
- PASS S1 UI start sends an Idempotency-Key and gets a saga :: key=83d236e0… saga=17bc472f-7035-499d-a125-1f2ee528b88a state=reserving errors=null
- PASS S1 UI polls durable status to active :: badges seen=[reserving -> active] history=[provisioning.requested, asset.reserved, asset.configured, inventory.activated, binding.ready]
- PASS S2 reload mid-provisioning restores the tracked saga after sign-in :: before=reserving signInRequired=true url=/provisioning?saga=7829fa54-d6c4-4135-ad89-0391e2243849 restoredState=configuring
- PASS S2 repeated Start after reconnect reuses the saga (no second saga) :: firstKey=6f41cc73 secondKey=6f41cc73 second=7829fa54-d6c4-4135-ad89-0391e2243849 sagasForDevice=1
- PASS S2 reconnected UI reaches active :: badges seen=[configuring -> active]
- PASS S5 bob (operator, tenant B) starts own provisioning through BFF :: saga=b44fad19-8ce2-4de4-a3e4-61c3cd00ea18 err=null
- PASS S3 participant down renders pending -> compensating -> repair required with admin redrive :: seen=[reserving -> reserving -> compensating -> compensating -> repair required] redriveButton=true
- PASS S3 viewer cannot redrive (API) :: code=insufficient_role
- PASS S3 admin redrive through UI completes compensation :: seen=[repair required -> compensating -> compensated] history=[provisioning.requested, deadline.compensate, deadline.expired, operator.replay, late_result.reconciled, asset.released]
- PASS S4 device-token ingest accepted hot and 48h-old readings :: hot=202 reading=4ff940d7-acc7-4740-afaf-b993a9831342 cold=202 {"status":"stored","reading_id":"4c85e71c-5aa1-4a0f-94ad-fb167ce6dc4f","event_id":"7468eecd-467c-4146-b4da-ba6276d84b61"
- PASS S4 UI search (Elasticsearch via BFF/Read API) finds the device :: serial=bre2e-fc53c424-main
- PASS S4 browser subscription uses ticket handshake and reconnects :: firstAck=true reconnected=true
- PASS S4 UI current/latest reading from the read DB :: row contains 18.25 °C / 61.5 %: true
- PASS S4 accepted reading ID reaches processed UI state after projection :: reading=4ff940d7-acc7-4740-afaf-b993a9831342 processed=true
- PASS S4 UI recent history (default 12 h, Postgres hot window) :: rows=1
- PASS S4 UI older range served from Cassandra :: ui has 48h-old 12.5 °C=true readApi source=cassandra rows=2
- PASS S8 Redis outage and browser WebSocket reconnect preserve scoped fresh reads :: accepted=202 reconnect=true projected=true tenantIsolation=true restored=true
- PASS S8 alert list is tenant scoped and viewer cannot acknowledge :: listed=true bobItems=0 viewer=insufficient_role
- PASS S8 admin acknowledges an alert through the gateway and UI refreshes :: openViewRemoved=true acknowledgedView=true responses=[{"status":200,"items":["33a28b8f-cbcd-4064-a6a0-e9d271af54c1","3e070f9a-ebff-44d9-a040-2aa29888e3da","81069c5e-c6e1-4909-8978-02edd6656211","a66a2cc3-46ad-4f4e-841a-ee387620758e"]},{"status":200,"ack":"acknowledged"},{"status":200,"items":["33a28b8f-cbcd-4064-a6a0-e9d271af54c1","3e070f9a-ebff-44d9-a040-2aa29888e3da","81069c5e-c6e1-4909-8978-02edd6656211"]},{"status":200,"items":["19d330d5-7964-4eec-8930-2513e642eecb","56ac6df2-e261-4f79-82cf-c4a79ca9b386","98562496-227b-4779-b0c6-54c0eb5538c6","a66a2cc3-46ad-4f4e-841a-ee387620758e","a6913295-1b44-41f7-bf1b-31ecc0447f21","c3f7fc22-2f3b-4e9f-8c97-9a190bd1b725"]}]
- PASS S5 bob search cannot see tenant A device :: query=bre2e-fc53c424-main
- PASS S5 bob GraphQL cannot read A's device, readings, saga or redrive :: device=null latest=null history=0 saga=not_found redrive=insufficient_role
- PASS S5 bob opening A's device URL sees not-found :: url=/devices/72c2b22f-2c32-4832-95ac-a6ebedf0dfcf
- PASS S5 bob opening A's saga URL gets an error, no status :: alert="not_found"
- PASS S5 viewer cannot start provisioning (UI hides/disables, API rejects) :: startVisible=false startEnabled=false api=insufficient_role
- PASS S5 bob still reads own tenant saga :: state=active
- PASS S6 accessibility smoke: zero serious/critical findings :: pages=sign-in,home,provisioning,devices blocking=[] other=[]
- PASS S7 loading state is announced (role=status) :: status="Searching devices…"
- PASS S7 Read API down: read views show an error, provisioning still works (partial) :: searchAlert="Device data is temporarily unavailable. Try again shortly." provisioningState=active
- PASS S7 recovery: read views return after the Read API is reachable :: search hit=true
