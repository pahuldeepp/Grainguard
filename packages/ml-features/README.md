# `ml-features`

Deterministic, offline-only first feature-kernel slice for canonical GreenGuard telemetry. This package is not wired to Kafka, a database, a service runtime, or a trained model.

The initial kernel consumes one tenant/device stream and uses only `temperature_c` and `relative_humidity_percent`. It applies both event-time (`observed_at`) and knowledge-time (`received_at`) cutoffs at `as_of`, so neither future observations nor late-arriving data can leak into a historical feature row. Missing measurements stay `None` and have explicit missing indicators.

Run focused tests from the repository root:

```sh
PYTHONPATH=packages/ml-features/src python3 -m unittest discover -s packages/ml-features/tests -v
```
