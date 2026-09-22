#!/usr/bin/env python3
"""Arithmetic planning model; never labels its inputs as measured performance."""
import json,math,pathlib
root=pathlib.Path(__file__).resolve().parents[1]
a=json.loads((root/'docs/capacity_assumptions.json').read_text())
u,w,c,r=(a[k] for k in ['user_confirmed','workload_assumptions','unverified_safe_cell_targets','resilience_assumptions'])
if r['regions_to_survive_losing']>=r['equally_sized_regions']:raise ValueError('Must retain at least one region')
api=u['concurrent_active_users']*w['api_requests_per_active_user_per_second']
devices=u['tenant_organizations']*w['devices_per_tenant'];eps=devices/w['device_report_interval_seconds']
sockets=u['concurrent_active_users']*w['websocket_sessions_per_active_user'];push=sockets*w['push_messages_per_session_per_second']
def cells(api_rate,event_rate):
    bounds={'api':math.ceil(api_rate/c['api_requests_per_second']),'telemetry':math.ceil(event_rate/c['telemetry_events_per_second']),'sessions':math.ceil(sockets/c['concurrent_sessions']),'tenants':math.ceil(u['tenant_organizations']/c['tenant_organizations'])}
    required=max(bounds.values());surviving_fraction=1-r['regions_to_survive_losing']/r['equally_sized_regions']
    return {'dimension_lower_bounds':bounds,'required_cells_lower_bound':required,'provisioned_cells_with_region_reserve_lower_bound':math.ceil(required/surviving_fraction)}
out={'status':'arithmetic forecast only; excludes unmeasured storage/network/device-count/skew/replay bottlenecks','api_rps':api,'device_count':devices,'telemetry_eps':eps,'telemetry_payload_bytes_per_second':eps*w['event_bytes'],'logical_event_payload_TB_per_day':eps*w['event_bytes']*86400/1e12,'replicated_kafka_payload_TB_for_retention':eps*w['event_bytes']*86400/1e12*w['kafka_replication_factor']*w['kafka_retention_days_example'],'concurrent_websockets':sockets,'delivered_push_messages_per_second':push,'push_payload_bytes_per_second':push*w['push_payload_bytes'],'refresh_requests_per_second_if_evenly_distributed':u['concurrent_active_users']/w['token_refresh_interval_seconds_example'],'baseline_cell_forecast':cells(api,eps),'burst_cell_forecast':cells(api*w['api_burst_factor'],eps*w['telemetry_burst_factor'])}
(root/'docs/CAPACITY_MODEL.json').write_text(json.dumps(out,indent=2)+'\n')
lines=['# Reproducible capacity arithmetic','',out['status']+'.','', 'Inputs: [capacity_assumptions.json](capacity_assumptions.json). Method: [capacity_model.py](../scripts/capacity_model.py). Context: [scale and production readiness](SCALE_AND_PRODUCTION_READINESS.md).','', '| Quantity | Calculated value |','|---|---:|']
for k,v in out.items():
    if isinstance(v,(int,float)):lines.append(f'| {k} | {v:,.3f} |')
for name in ['baseline_cell_forecast','burst_cell_forecast']:
    lines+=['',f'## {name}','', '```json',json.dumps(out[name],indent=2),'```']
lines+=['','Cell values are unverified targets. These calculations are lower bounds and not a deployment recommendation, hardware benchmark, provider quota approval or production readiness certificate.','']
(root/'docs/CAPACITY_MODEL.md').write_text('\n'.join(lines))
print(json.dumps(out,indent=2))
