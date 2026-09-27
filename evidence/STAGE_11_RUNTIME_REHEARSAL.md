# Stage 11 isolated runtime rehearsal

Date: 2026-09-27

## Scope and isolation

Ran the dedicated `greenguard-obs-rehearsal` project. It starts its own
Prometheus and Alertmanager containers, an in-process metrics target, and a
loopback webhook receiver. It does not connect to a GreenGuard database,
Kafka, or the shared observability stack. The only injected failures were
controls on that synthetic target; no shared service or dependency was
stopped or modified.

Command:

```sh
REHEARSAL_FACTOR=60 \
REHEARSAL_ALERTS=ObservabilityTargetDown,APIHighServerErrorRate,KafkaBrokerUnavailable \
make observability-rehearse
```

The generated rules passed `promtool check rules`: 23 platform, 39 broker, and
65 SLO rules. The rehearsal unit suite passed 8/8 tests.

## Runtime results

All selected alerts passed the full Prometheus and Alertmanager path: healthy
baseline, injected signal, pending, firing, local webhook delivery, signal
recovery, and resolved webhook notification.

| Scenario | Pending (s) | Firing (s) | Firing webhook (s) | Resolved (s) | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Target scrape failure (`ObservabilityTargetDown`) | 0.8 | 3.8 | 5.8 | 14.8 | Pass |
| Kafka broker unavailable (`KafkaBrokerUnavailable`) | 1.3 | 3.3 | 5.3 | 15.1 | Pass |
| HTTP 5xx increase (`APIHighServerErrorRate`) | 1.5 | 6.6 | 8.6 | 15.1 | Pass |

This proves the rehearsal series are scraped, the corresponding rules evaluate,
and a firing plus resolved event reach the configured local webhook. The API
scenario is generated synthetic traffic represented by bounded method, route,
status labels; it is not a load test against a running GreenGuard service.

## Dashboard and metric wiring inspection

Parsed all five provisioned Grafana dashboard JSON files successfully. The
dashboard provider loads `/var/lib/grafana/dashboards` into the GreenGuard
folder, and the provisioned Prometheus datasource uses the local Prometheus
service. `GreenGuard — Platform Overview` contains 11 panels, including
request rate, server error rate, p50/p90/p95/p99 latency, host CPU/memory, CDC
lag/quarantine, candidate SLO/error budget, and ingest accepted/rejected
series. RED queries aggregate by bounded `job`, `route`, and status dimensions;
no tenant, device, or request identifier is used as a Prometheus label.

Dashboard verification here is source/provisioning inspection. I did not query
the shared Grafana UI/API or claim a live dashboard rendering check, so the
runtime dashboard presentation remains unverified by this rehearsal.

## Limits

- Synthetic RED series exercise the scrape/rule/notification path, not
  representative throughput, tail latency, saturation under load, or the
  service's real instrumentation.
- Broker failure is represented by a synthetic Kafka exporter series; no live
  broker was failed in this rehearsal.
- The rehearsal proves the local Alertmanager webhook sink only. It does not
  prove production paging, AWS signals, or external notification delivery.
- This does not close SLO approval or establish production SLO attainment.
