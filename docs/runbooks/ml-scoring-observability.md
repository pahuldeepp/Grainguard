# Runbook: GreenGuard ML scoring observability

**Scope:** the opt-in synthetic shadow scorer. These signals do not authorize a model promotion or change risk/alert decisions. Real-world model validity remains a separate data and evaluation gate.

## MLScoringFeatureDriftHigh

**Means:** the rolling input-feature distribution has PSI above 0.25 compared with the model bundle's synthetic reference.

**First checks:** open the GreenGuard ML Scoring Health Grafana dashboard; compare PSI by feature and model version, check `greenguard_otel_ml_scoring_input_temperature_celsius` / `greenguard_otel_ml_scoring_input_relative_humidity_percent` distributions, and inspect the scorer logs in Loki for the PSI breach event.

**Action:** confirm whether the change is an expected synthetic fixture shift or a pipeline/schema regression. Do not auto-promote or claim real-world drift from synthetic-only evidence. Create a new reference/model candidate only through the documented offline evaluation gates.

## MLScoringShadowOutboxPublishFailures

**Means:** scorer output is not reaching the shadow Kafka topic reliably.

**First checks:** inspect scorer `/readyz`, Kafka broker/producer health, consumer/outbox relay errors in Loki, and `greenguard_otel_ml_scoring_shadow_outbox_published_total` versus failures.

**Action:** keep the shadow deployment out of any product decision path; restore broker connectivity and confirm the outbox drains before considering the scorer healthy.

## MLScoringDriftStatePersistenceFailures

**Means:** current PSI is observable in process memory, but a durable drift checkpoint failed to persist.

**First checks:** inspect PostgreSQL availability, `ml_drift_status` permissions/RLS, scorer logs, and database connection saturation.

**Action:** restore persistence and verify a restart restores the saved window. Do not use a reset or partial drift window as promotion evidence.

## MLScoringInferenceP99High

**Means:** model inference p99 exceeded the provisional 50 ms guardrail for ten minutes.

**First checks:** inspect `greenguard_otel_ml_scoring_model_inference_milliseconds` and `greenguard_otel_ml_scoring_event_processing_milliseconds` on the dashboard; check CPU throttling, model bundle/version changes, and scorer restart history.

**Action:** keep the model in shadow; profile or scale only after checking measured load and resource limits. The threshold is an operational guardrail, not an SLA for real workloads.
