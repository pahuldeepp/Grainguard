# Reproducible capacity arithmetic

arithmetic forecast only; excludes unmeasured storage/network/device-count/skew/replay bottlenecks.

Inputs: [capacity_assumptions.json](capacity_assumptions.json). Method: [capacity_model.py](../scripts/capacity_model.py). Context: [scale and production readiness](SCALE_AND_PRODUCTION_READINESS.md).

| Quantity | Calculated value |
|---|---:|
| api_rps | 2,000,000.000 |
| device_count | 100,000,000.000 |
| telemetry_eps | 1,666,666.667 |
| telemetry_payload_bytes_per_second | 1,706,666,666.667 |
| logical_event_payload_TB_per_day | 147.456 |
| replicated_kafka_payload_TB_for_retention | 3,096.576 |
| concurrent_websockets | 10,000,000.000 |
| delivered_push_messages_per_second | 1,000,000.000 |
| push_payload_bytes_per_second | 1,024,000,000.000 |
| refresh_requests_per_second_if_evenly_distributed | 11,111.111 |

## baseline_cell_forecast

```json
{
  "dimension_lower_bounds": {
    "api": 100,
    "telemetry": 84,
    "sessions": 100,
    "tenants": 100
  },
  "required_cells_lower_bound": 100,
  "provisioned_cells_with_region_reserve_lower_bound": 150
}
```

## burst_cell_forecast

```json
{
  "dimension_lower_bounds": {
    "api": 200,
    "telemetry": 417,
    "sessions": 100,
    "tenants": 100
  },
  "required_cells_lower_bound": 417,
  "provisioned_cells_with_region_reserve_lower_bound": 626
}
```

Cell values are unverified targets. These calculations are lower bounds and not a deployment recommendation, hardware benchmark, provider quota approval or production readiness certificate.
