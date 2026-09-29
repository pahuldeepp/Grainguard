# I1 Data, simulator and feature kernel · I2 Classical ML ladder, backtesting and MLflow

Status: DRAFT design section for GreenGuard Intelligence. Nothing here is built. All capacity numbers are **UNMEASURED** estimates until a Stage I13 run records them under `evidence/`.

**Binding source:** this section conforms to [README.md](README.md) rev 2 §2 (R1–R32), §3 name registry, §4 changes table and §5 stage table. Where anything below disagrees with the README, the README wins. Cloud-specific parts (EKS, S3 with SSE-KMS, RDS for PostgreSQL, EKS Pod Identity) follow [ADR-0024](../adr/0024-aws-platform.md) (accepted, R29) and are certified in I13; until then the same jobs run in the local/Compose profile.

Grounding read for this section: `services/risk-engine/README.md`, `risk_engine/scoring.py`, `risk_engine/join.py`, `docs/FIRST_VERTICAL_SLICE.md` §3–5, `docs/adr/0006-ingest-quality-and-lateness.md`, `docs/adr/0009-binding-feed-freshness.md`, `docs/adr/0011-read-history-retention.md`, `docs/CAPACITY_MODEL.md`, and the event schemas in `contracts/events/` (`telemetry-recorded.v1`, `lot-changed.v1`, `device-binding-changed.v1`, `site-changed.v1`, `bin-changed.v1`).

---

## 0. Plain-language summary

- **The simulator** is a physics model of a grain bin. It calculates, every few simulated minutes, how warm and damp each part of the grain is, from the weather outside, the fans, the grain breathing (respiration) and insects. It then pretends to be the 16 temperature/humidity sensors inside the bin and produces a reading from each one every 15 minutes. Because the simulator knows the truth (“spoilage started here at 03:10 on day 41”), those readings come with correct answers we can train and test against.
- **Two routes for simulated data.** The *bulk* training corpus (hundreds of millions of readings) goes straight from the simulator into the feature kernel and out to Parquet files — sending it through the real ingest pipeline would take weeks. A small *parity sample* (about 20 bin-seasons) does go through the real pipeline, and it must produce exactly the same features as the direct route. That proves the shortcut does not change the data.
- **The feature kernel** (`packages/ml-features`) turns raw readings into useful numbers (“temperature rose 1.8 °C in 24 h at 3 m depth”, “this cable is 6 °C warmer than its neighbours”). It must only use information that was actually available at the moment a prediction would have been made; otherwise the model “cheats” in testing and fails in real life. The same kernel code runs offline (I1, building training data) and online (I5, inside `ml-scoring`).
- **The classical ML ladder** is a sequence of increasingly capable models — “tomorrow looks like today” (persistence), the existing threshold rules, straight-line models, then gradient-boosted trees — each of which must beat the one below it by a statistically honest margin before we accept it.
- **Backtesting** replays history as if we were living through it: train on the past, predict the next period, move forward, repeat.
- **MLflow** is the lab notebook and model shelf: every experiment, dataset hash, metric and model version is recorded there. It does **not** decide which model is live — a deployment file in Git does (R10).

---

## 1. Where this sits in the existing platform

```
                        ┌───────────── bulk corpus (R4) ─────────────┐
grain-sim (tool) ──readings + delivery times──▶ ingest-rule emulator ▶ packages/ml-features kernel ▶ Parquet
     │                                                                                   (bin_features,
     │ ground-truth labels (never via ingest) ─────────────────────────────────────────▶  sequence_windows,
     │                                                                                     labels) + manifest
     │                                                                                          │
     └── parity sample (~20 bin-seasons) ──device tokens──▶ gateway ▶ telemetry-ingest           │
            (synthetic tenant, backfill endpoint ADR-0025)   (reading+outbox+receipt+audit tx)   │
                                                                │ Debezium CDC ▶ cdc-transformer  │
                                                                ▼                                 │
                        canonical Kafka (R3): greenguard.telemetry.recorded.v1,                   │
                        greenguard.inventory.device.v1 / .lot.v1 / .facility.v1                   │
                                                                │                                 │
                                   I1: parity harness replays these into the same kernel ─── compare (I1-G7)
                                   I5: ml-scoring online consumer (greenguard_ml) ────────── compare (I5 gate)
                                                                                                  ▼
                                            training jobs ▶ MLflow tracking + registry (aliases = projection)
                                                                                                  │
                                         promotion job ▶ gate report ▶ PR to infra/gitops deployment manifest (R10)
```

The existing deterministic `risk-engine` stays the **authority** for alerts (R7: policy version, UUIDv5 identities, invalidation ledger). Nothing in I1/I2 writes to `greenguard_risk`. Classical models are evaluated offline here; online/shadow scoring is I5's job. The threshold engine is a *baseline* in the I2 ladder, re-implemented by importing `risk_engine.scoring.assess` unchanged so the baseline is the production code, not a copy.

### 1.1 Deliverables and ownership

There is **no `feature-service` and no `greenguard_features` database** (R1, R2). Feature state has one owner: `ml-scoring` owns `greenguard_ml`, including online window state; its streaming consumer is built in **I5**. I1 delivers the shared kernel, the offline corpus and the tooling around them.

| Deliverable (stage) | Language / location | Owns (single write owner) | Consumes | Produces |
| --- | --- | --- | --- | --- |
| `grain-sim` (I1) — library + CLI + fleet driver | Python, `tools/grain-sim/` (a tool, not a service; runs as a Job) | no database: run records, labels and the parity-sample send ledger are run artifacts in the dataset bucket (§3.7) | weather cache (hashed files), scenario library (git) | reading stream + delivery times; labels; for the parity sample only, HTTP calls to the public API as a real client |
| `packages/ml-features` (I1) | Python package; depends on `packages/grain-physics` and pins `risk_engine` for the baseline signal | nothing (pure functions over immutable window state) | readings, inventory facts, ambient observations | feature rows and sequence windows; the **one** kernel used offline (I1) and online (I5, R2) |
| `packages/grain-physics` (I1) | Python package | nothing | — | EMC, psychrometrics, DML helpers shared by simulator and kernel so they cannot disagree silently |
| Offline corpus builder (I1) | Python, `ml/corpus/`, Job | the dataset bucket objects it writes | simulator output, labels, weather cache | Parquet dataset (§3.7) + manifest |
| Parity harness (I1) | Python, `ml/corpus/parity/`, test Job | nothing persistent (scratch only) | canonical topics for the parity tenant (R3 names) | parity report for I1-G7 |
| `packages/otel-py` (I1, R28) | Python package | nothing | — | OTel setup per ADR-0004: live-span `traceparent` stored on outbox rows, no tenant IDs or text in labels/attributes; built in I1 before any Python AI service emits events |
| Training (`ml/classical/`) (I2) | Python, Jobs | MLflow runs/model versions | dataset snapshots | registered model versions, model cards, gate reports |
| MLflow server (I2) | Deployment; backend DB `greenguard_mlflow` (owner: ml-platform, §3), S3 artifact bucket (SSE-KMS), OIDC in front (ALB OIDC authentication or oauth2-proxy) | experiments, registry | — | — |
| Online feature consumer, `node_window_state`, revisions, ambient reference table, real-tenant export (**I5**, specified here) | `services/ml-scoring/` (`greenguard_ml`) | ml-scoring | R3 topics | see §3.6 |

### 1.2 Contract changes this section depends on (G1–G8 → README §4)

The current contracts cannot describe a real grain bin. Each change is additive and owned by the existing owner service, not by Intelligence. Every row maps to a README §4 row, which carries its stage and exit test.

| Gap | Today | Proposal | Owner | README §4 row (stage, exit test) |
| --- | --- | --- | --- | --- |
| G1 Sensor position | A device has `bin_id` only; `measurements` = `temperature_c`, `relative_humidity_percent` only | **One cable node = one device** (R5; fits `telemetry.recorded.v1` unchanged). Add device mount metadata `{cable_label, node_index, depth_m, radial_m, role: grain|headspace|plenum|ambient}` with a `mount_version`, published as `device.mount_changed.v1` on the existing `greenguard.inventory.device.v1` topic | device-service | “Mount/position and lot-sample events; `site.changed.v2`, `bin.changed.v2`” (I1; contract tests + two-tenant test) |
| G2 Grain moisture | `lot.changed.v1` has crop and variety, no moisture | `lot.sample_recorded.v1` `{lot_id, bin_id, sampled_at, moisture_percent_wb, test_weight?, method}` on `greenguard.inventory.lot.v1`; operators and simulator both emit it | device-service | same row as G1 |
| G3 Site location | `site.changed.v1` has no location | Optional `location: {lat, lon}` rounded to 0.1° (≈11 km; enough for reanalysis weather, coarse for privacy) in `site.changed.v2` | device-service | same row as G1 |
| G4 Bin geometry / aeration | none | Optional `geometry: {diameter_m, eave_height_m, capacity_t}`, `aeration: {fan_count, design_airflow_m3_min_t}` in `bin.changed.v2`. Fan on/off as a 0/1 “measurement” is **rejected** (not a measurement type); `aeration.state_changed.v1` is a later, separate proposal | device-service | same row as G1 |
| G5 CO₂ | not a measurement type; ingest rejects unknown types; risk-engine `assess` raises on unknown keys | **Deferred, no §4 row**: adding `co2_ppm` is a breaking change for the strict risk-engine consumer and needs a coordinated v2 rollout under its own ADR. I1 simulates CO₂ internally and labels it but does **not** send it | telemetry-ingest + risk-engine | none (out of I-track scope until an ADR adds a row) |
| G6 Backfill ingest | ADR-0006 rejects `observed_at` older than 7 days and defers backfill | Backfill endpoint per **ADR-0025** (R32), §2.6 | telemetry-ingest | “Backfill endpoint (ADR-0025)” (I1; receipt-per-reading + no-notify tests) |
| G7 Synthetic tenant marker | none | `tenant.synthetic = true`; synthetic tenants **never notify** (R32) | tenant-control-plane; notification-service | “`tenant.synthetic` flag …” (I1 synthetic) and “Notification suppression for synthetic/backfilled” (I1; no send for synthetic tenant) |
| G8 Training consent | none | `greenguard.tenant.ai_consent.v1` per **R24** (§3.8): `training ∈ {none, own_tenant, pooled}`, `eval_review: bool` | tenant-control-plane | “… `tenant.ai_consent.v1` …” (I2 consent; event contract + revocation tests) |
| — Python tracing | no Python OTel helper | `packages/otel-py` (R28) | packages | “Python OTel helper `packages/otel-py`” (I1; traceparent on outbox rows) |

New event types ride the inventory topics already listed in R3 (routing entries in `services/cdc-transformer/event.go`); no new topic is introduced by I1.

Rejected alternative for G1: a multi-node `telemetry.recorded.v2` with an array of node readings. It lowers row count ~16× for the reference bin but changes the ingest transaction, the receipt/idempotency unit, the risk-engine join and every projection at once. Device-per-node reuses every proven path; revisit at Stage 13 if the measured row rate is the bottleneck.

Rejected alternative for G1: an Intelligence-owned `sensor_topology` table. It would make installation facts live in two services and break “one write owner per aggregate”.

---

## 2. I1-A Physics-based grain-bin simulator

### 2.1 Model

Axisymmetric 2-D finite-volume grid (radius × height), default 8 radial × 20 vertical cells, explicit time step **5 min** (divides the 15-min reading cadence) with a CFL/stability check that halves the step when violated. A 1-D vertical mode exists for fast unit tests.

| Process | Equation / source (verify constants in ADR before use) | Notes |
| --- | --- | --- |
| Conduction | ρ_b·c_b·∂T/∂t = ∇·(k∇T) + q_resp + q_insect − q_aeration − q_latent | Bulk density, specific heat and conductivity per crop and moisture from ASABE data tables |
| Respiration heat and dry-matter loss (DML) | Thompson-type DML rate as a function of grain temperature, moisture and elapsed time; heat from glucose oxidation (≈15.7 MJ per kg dry matter respired); CO₂ ≈ 1.47 g per g DML | Rate multipliers per crop are parameters, not constants; each has a citation in `tools/grain-sim/PARAMETERS.md` |
| Equilibrium moisture content (EMC) | Modified Chung–Pfost and modified Henderson (ASABE D245.x constants per crop); the implementer chooses per crop the equation the standard recommends | Lives in `packages/grain-physics`, shared with the feature kernel |
| Moisture migration | Vapour diffusion driven by vapour-pressure gradient + a natural-convection term driven by the wall-to-centre temperature gradient; produces the classic winter “top-centre crusting” | Moisture changes by sorption toward EMC with a first-order time constant |
| Aeration | Fan state schedule or controller (e.g. run when ambient < grain − 5 °C and ambient RH gives EMC ≤ target); airflow per tonne sets the cooling/drying front speed; air enters at plenum and exchanges heat and moisture cell by cell | Fan state is ground truth in the labels (G4 not required for the simulator itself) |
| Ambient weather | Hourly T and RH from Open-Meteo’s historical API (ERA5 reanalysis, 1940→present), interpolated to the step; solar/wall heating as a simple wall boundary condition | Data licence CC BY 4.0 (attribution required); the free API is for non-commercial use with rate limits. Production source is an owner decision (README §8 Q7) |
| Insects | Logistic population in a seeded cell, growth rate a function of T and moisture, heat and CO₂ per unit population; creates a hotspot that spreads by conduction | Ground truth: seed time, cell, population curve |
| Hotspots (non-insect) | Wet pocket (a lens of higher moisture from a roof leak or loading) → higher respiration → heat | Ground truth: pocket region, moisture |

Physics is deliberately “credible, not certified”: it must reproduce qualitative behaviour (cooling fronts, winter top-centre condensation, self-heating in wet pockets) and published EMC tables. It is not a validated agronomic model and the model card says so.

### 2.2 Sensors (R5) and the fault-injection class list (R31)

**Reference bin (R5, the only sensor model used anywhere in I1/I2):** one cable node = one device; **4 cables × 4 depths = 16 devices per bin** (1 centre cable, 3 at ⅔ radius; 4 nodes per cable spread evenly over the grain depth, all role `grain`). Each device reports every **15 min**. The feature/forecast grid is **15 min per bin**; I4's patch is 8 steps (2 h). A node samples the cell it sits in, adds calibrated noise (σ ≈ 0.1–0.3 °C), and quantises to the sensor's resolution. Ambient conditions come from the weather data (§2.1), not from a device. Headspace/plenum/ambient devices are allowed by the G1 contract and may appear in named scenario variants, but they are outside the reference bin, the corpus defaults and every capacity figure.

The injector produces two kinds of injection. Only the first kind is a **sensor-fault class**; this list is authoritative for C2 (§4.1) and for I11's fault-triage adapter, which may use exactly these classes and no others (R31).

**Sensor-fault classes, `fault_class_set_version = fc1`** (labelled `sensor_fault{type=…}`):

| Class (`type`) | Injection | Label |
| --- | --- | --- |
| `stuck` | Value frozen at last reading | interval |
| `drift` | Linear bias growing over time, e.g. +0.5 °C/week | interval + true bias curve |
| `offset` | Constant calibration bias from install or after a swap, e.g. +1.5 °C | interval + bias |
| `noise` | σ × k | interval + k |
| `spike` | Single outliers within the valid range | points |
| `dropout` | A node stops transmitting for a period (ends in resume or nothing) | interval |
| `cable_break` | All nodes on a cable at or below index k go silent together | interval + k |

Not in `fc1` and therefore not usable by I11: `battery_brownout`, `cross_wired`, `clock_skew`, or any other name. Adding a class needs an I1 injector change, a new `fault_class_set_version` and, if it touches the reading shape, a telemetry contract change.

**Delivery and metadata injections** (test the pipeline, not labelled as sensor faults, excluded from C2 and I11):

| Injection | What it does | Expected outcome |
| --- | --- | --- |
| Out-of-range | Values beyond −80..120 °C | ingest rejection `value_out_of_range` (emulated in bulk, real in the parity sample) |
| Store-and-forward | Buffered while offline, then sent late in a burst (out of order) | `late_delivery`; exercises ADR-0006 lateness and knowledge time |
| Clock offset | `observed_at` shifted ± minutes/hours | > 5 min future ⇒ `timestamp_in_future`; a delivery-path test only |
| Duplicate retransmission | Same `source_message_id`, same body | idempotent replay; different body ⇒ `idempotency_conflict` |
| Mount swap | Two nodes' positions swapped in mount metadata | `mount_error` metadata label; a hard case for spatial features |

### 2.3 Ground-truth labels (`label_spec_version` = 1)

| Label | Definition | Grain |
| --- | --- | --- |
| `spoilage_onset` | first time the bin's worst cell's cumulative DML exceeds **0.5 %** (owner decision, README §8 Q8) | bin, timestamp, cell |
| `hotspot_onset` | first time a connected region ≥ 1 cell has T − bin median ≥ **5 °C** for ≥ **6 h** (README §8 Q8) | bin, timestamp, region |
| `insect_active` | population above detection threshold | bin, interval |
| `sensor_fault` | any `fc1` fault, per node | node, interval, type |
| `aeration_on` | fan state | bin, interval |
| `condensation` | cell RH at the grain surface ≥ 100 % | bin, interval, cell |

Labels are written only to the `labels` export of the dataset (§3.7), with the same pseudonymised keys as the features; devices never see them and they never pass through ingest. They join to features by `(tenant, bin or device, time)`, never by reading ID, because features exist at times with no reading.

### 2.4 Determinism

- `scenario_id` = SHA-256 of canonical JSON of `{scenario spec, grain-sim version, grain-physics version, weather file SHA-256, seed}`.
- Random streams: `numpy.random.SeedSequence(seed).spawn(...)` in a fixed, keyed order — one child per bin, per node, per fault — so adding a bin does not change other bins' noise. Generator: PCG64.
- No wall-clock reads inside the model; the driver maps simulated time to `observed_at` and the delivery model to `received_at`.
- `source_message_id` = `sim.{run_short}.{node}.{seq}` — stable across retries, so an interrupted parity-sample run resumes without duplicates (ingest receipts prove it). Reading IDs are created once and never regenerated.
- Floating point: pin NumPy, run single-threaded BLAS in the model loop; determinism is asserted byte-for-byte on the **emitted reading stream**, not on intermediate arrays.

### 2.5 Two routes: bulk corpus and real-ingest parity sample (R4)

**Why the bulk corpus cannot go through ingest.** The training tier is 1,000–2,000 bin-seasons. At the R5 reference bin that is 16 devices × 96 readings/day × 180 days ≈ **276k readings per bin-season**, so 1,000 bin-seasons ≈ **276M readings**. `docs/CAPACITY_MODEL.md` budgets about 200 events/s per cdc-transformer worker; one worker would need ≈ 16 days, and the load would sit in a shared cell's ingest, CDC and Kafka while real tenants use it. The previous plan (“285M readings through ingest in ≈ 16 h at 5k readings/s”) assumed a rate nothing in the platform has measured and is withdrawn.

| Route | Size | Path | What it proves |
| --- | --- | --- | --- |
| **Bulk corpus** | training tier 1,000–2,000 bin-seasons; dev tier 20 bin-seasons of 30 days | simulator → **ingest-rule emulator** (applies ADR-0006 validation: range, finiteness, future limit, duplicates; assigns `received_at` from the delivery model) → `packages/ml-features` kernel → Parquet (§3.7). No HTTP, no Kafka, no platform database | nothing about the pipeline by itself — it is trusted only because of the parity gate |
| **Real-ingest parity sample** | ~**20 bin-seasons**, covering every scenario family and every injection in §2.2 | synthetic tenant (G7) → gateway → telemetry-ingest (backfill endpoint, §2.6) → Debezium CDC → cdc-transformer → R3 canonical topics → same kernel (I1 parity harness; in I5, the ml-scoring online consumer) | the bulk route produces **identical** features, and the emulator's accept/reject decisions equal real ingest's (I1-G5, I1-G7). A gate in I1 **and** I5 |

Parity-sample driver steps (an ordinary API client of a synthetic tenant):

1. Provision tenant/site/bin/devices/lot through the gateway `/v1` APIs with a machine client (ADR-0018/0020) bound to that tenant. Record returned IDs in the run artifact; never mint platform IDs locally.
2. Obtain per-device tokens (Q6: a `device` role token whose subject is the device); a node can only write its own readings.
3. POST readings; honour `429 Retry-After` (ADR-0007) with jittered backoff; treat 4xx reasons as data: every send is recorded in the run's send ledger with the ingest outcome, so **sent = accepted + rejected-by-reason**, reconciled per run.
4. Lot placement, lot samples and mount changes go through device-service APIs, so the event-time lot join sees exactly what production sees.

Rejected: writing canonical-shaped events straight to Kafka for training. It skips ingest validation, receipts, CDC and transformer ordering while still loading shared brokers; the bulk route skips the platform entirely instead, and the parity sample covers the pipeline. Allowed only in simulator unit tests against a sandbox topic.

### 2.6 Time: live mode vs backfill (R32, ADR-0025)

ADR-0006 rejects readings older than 7 days on the live endpoint, so a 180-day parity season cannot be replayed through it.

| Mode | Use | Path |
| --- | --- | --- |
| Live | E2E tests, demos, I5 shadow scoring | real time (or ≤ 7 days old), live endpoint |
| Backfill | Parity-sample seasons (bulk never uses it) | the **separate authenticated backfill endpoint** of ADR-0025 (amends ADR-0006): same reading+outbox+receipt+audit transaction and idempotency, **one reading per receipt** (each reading is its own transaction; batching limits are ADR-0025's), separate role and rate-limit bucket, maximum age set by the owner (README §8 Q6; proposal 400 days). Every reading carries **`backfilled = true`** |

Alerts: the risk-engine still scores backfilled readings, but **synthetic tenants and backfilled readings never notify** — resulting alerts are recorded as backfilled and notification-service suppresses them (G7 row). This applies to real tenants' backfill as well; there is no age threshold to choose.

The kernel reads `backfilled` directly from the reading (no derivation from `received_at − observed_at`), and backfilled readings are treated as a recompute of historic windows (§3.4).

### 2.7 Scenario library

Scenarios are YAML in `tools/grain-sim/scenarios/`, reviewed like code. Families (each with ≥ 3 weather years and ≥ 3 regions):

| Family | Examples |
| --- | --- |
| Healthy storage | well-aerated wheat, dry canola, winter cooling |
| Wet harvest | 16–18 % wheat without drying; partial aeration |
| Wet pocket | lens at centre, at wall, near surface |
| Insects | seeded in warm pocket, varying seed time |
| Moisture migration | long winter without aeration; condensation |
| Aeration misuse | fans in humid weather re-wetting grain |
| Sensor faults only | every `fc1` class on a healthy bin (false-alarm tests) |
| Combined | fault + real hotspot on the same cable (the hard case) |
| Crop change | lot switch mid-season (tests event-time lot join) |
| Operational chaos | dropout then store-and-forward burst, clock offset, mount swap |

Tiers (UNMEASURED): training 1,000–2,000 bin-seasons (≈ 276M–553M readings, bulk route only); dev 20 bin-seasons of 30 days (≈ 0.9M readings); parity sample ~20 bin-seasons of 180 days (≈ 5.5M readings through real ingest — ≈ 7.7 h at 200 events/s, run on a staging cell, never a shared production cell).

---

## 3. I1-B Feature kernel and datasets

### 3.1 Point-in-time rule (bitemporal)

A feature row describes entity *e* **as of** time *t* and may use a fact only if:

- its **event time** ≤ t (reading `observed_at`, lot `effective_from`, sample `sampled_at`, mount `valid_from`), **and**
- its **knowledge time** ≤ t, where knowledge time = `received_at` for readings and the canonical event's source commit time for inventory facts.

Plain language: “we only use what had happened *and* what we had already heard about.” A reading observed at 10:00 but delivered at 14:00 (store-and-forward) must not appear in a 12:00 feature row used for training, because at 12:00 the online system did not have it. Using event time alone is the most common leak in sensor ML. In the bulk route, knowledge time comes from the simulator's delivery model; the parity sample checks that model against real `received_at` values.

Lot selection reuses the risk-engine rule (half-open `[effective_from, effective_to)`, not-ready when unproven) by importing `risk_engine.join.select_lot`, plus the knowledge-time filter on the lot event's commit time. The ADR-0009 checkpoint gate is honoured the same way: an open interval is trusted only up to the lot-feed watermark.

### 3.2 Feature set v1 (`feature_set_version` = `fs1`)

Entity levels: node (device), cable, bin. Windows: 1 h, 6 h, 24 h, 72 h, 7 d. Cadence: bin rows every **15 min** of event time (R5 grid).

| Group | Features |
| --- | --- |
| Level | last value, mean, min, max, std, EWMA (half-lives 6 h, 24 h) per node |
| Trend | OLS slope over window (°C/h), second difference, max 6 h rise |
| Spatial | node − cable median, node − bin median, vertical gradient between adjacent nodes, max neighbour delta, top-layer mean − core mean |
| Psychrometrics | dew point (Magnus formula), grain EMC from interstitial air T/RH (shared `grain-physics`), EMC − latest sampled moisture; top-layer grain temperature vs ambient dew point (condensation risk; headspace dew point used only when a headspace device exists) |
| Ambient | ambient T/RH, grain − ambient delta, degree-hours above 15/20/25 °C, ambient EMC (aeration opportunity) |
| Lot | crop, days in storage, latest sampled moisture and age of that sample, crop-specific safe-storage-days lookup |
| Data quality | readings in window / expected (expected = window ÷ 15 min), max gap, flat-line duration, rolling variance floor, lateness p95 (`received_at − observed_at`), share of backfilled readings |
| Baseline signal | the threshold engine's score for the latest reading (`risk_engine.scoring.assess` called in-process, same policy version) |

Removed from rev 1: “share of values rejected at ingest”. It was computable only from the simulator ledger in training and not per device online, so it was train/serve skew by construction.

Absent is never zero (same rule as scoring.py): missing inputs are `NULL`/`NaN` with an explicit `*_missing` indicator; LightGBM handles NaN natively; linear models use indicator + median-from-training imputation stored in the model artifact.

### 3.3 One kernel, online and offline (R2)

`packages/ml-features` exposes pure functions over an immutable `WindowState` and an `as_of`, plus a `sequence_window(...)` builder for the per-node series. Drivers call the same kernel:

- **Offline corpus driver (I1):** feeds simulator output (after the ingest-rule emulator) in knowledge-time order and writes Parquet.
- **Parity harness (I1):** consumes the parity tenant's R3 canonical topics in knowledge-time order into the same kernel, in scratch memory, and diffs the result against the offline driver.
- **Streaming driver (I5, ml-scoring):** Kafka consumer with inbox; state in `greenguard_ml`. Not built in I1.
- **Replay driver (I5):** retained canonical events (Kafka replay, then Cassandra history via its read contract for older data) for new feature versions and recovery.

Rejected: SQL window functions for offline and Python for online (two implementations drift). Rejected: Flink/Beam/Spark Structured Streaming for I1 — large operational surface for a Python team at a measured-unknown rate; revisit in I13 with measured throughput.

### 3.4 Lateness, recompute and revisions (ADR-0006)

These are kernel semantics, identical offline and online:

- Window close: bin watermark (max `observed_at` seen across its nodes) passes window end + **10 min** allowed lateness (ADR-0006's initial value).
- A reading arriving after close always updates state and triggers recompute of every affected closed window; the result is a **new revision** (`revision` +1) with its own `computed_at`. Revisions are append-only.
- Training can choose the view: **as-seen** (latest revision with `computed_at ≤ as_of + serving_delay`) — the default, because it matches what online scoring saw — or **corrected** (latest revision overall) for label-side analyses only.
- Readings with `backfilled = true` (R32) are treated as a recompute of historic windows and their revisions carry `ingest_path = backfill`.
- Invariant tested: incremental result after any delivery order = batch recompute on the full set (ADR-0006 “recomputation must equal incremental results”).

### 3.5 Identity and idempotency

- Feature row key `(tenant, entity_type, entity_id, as_of, feature_set_version, revision)`; `feature_row_id` = UUIDv5 of that tuple + input digest. Created once; replays reproduce the same ID. A replay producing a different digest for the same revision is an incident (quarantine + alert), not an overwrite. In exported Parquet the ID is recomputed over the pseudonymised keys (§3.7), so no raw tenant ID can be recovered from it.
- Online obligations for I5 (specified here so the kernel supports them): `consumer_inbox(consumer_name, tenant_id, event_id, digest)` — same ID + same digest ⇒ no-op; different digest ⇒ quarantine `event_id_conflict`; offsets commit only after the tenant transaction or a quarantine row commits; lock choice (P3) per-bin `pg_advisory_xact_lock(hash(tenant, bin))` (hot single-entity contention ⇒ pessimistic, consistent with the risk-engine per-bin lock order), documented next to the ml-scoring migration.

### 3.6 Storage (feature store decision)

**Decision: online window state and revision history in Postgres `greenguard_ml` (owner ml-scoring, built in I5) + immutable Parquet dataset snapshots for training (built in I1).** No Feast on the critical path.

| Option | Why rejected / chosen |
| --- | --- |
| Postgres + Parquet (chosen) | Same RLS/set_config/PgBouncer/migration patterns already proven; transactional inbox + feature write; daily partitions and retention like ADR-0011; Parquet snapshots are immutable and hashable |
| Feast (Postgres offline/online is a *contrib* store) | Its point-in-time join (`get_historical_features`) is good, but it is event-time only (no knowledge-time filter without extra columns), manages its own connections (per-transaction `set_config` tenant context is not guaranteed), and its materialisation jobs are a second code path next to our Kafka consumer. Keep as an optional lab for comparison |
| Cassandra as feature store | Good for high-fan-out online reads at Tier U, poor for bitemporal as-of queries and revisions. Candidate derived online cache in I13 if Postgres read latency fails SLO |
| Redis online store | Derived cache only, tenant-prefixed keys, rebuilt from Postgres; not a source of truth |
| SageMaker Feature Store | Vendor lock-in and a separate tenancy model; conflicts with existing RLS invariants |

Tables in `greenguard_ml` that serve features (**I5 builds them**; all tenant tables: `tenant_id`, forced RLS, composite tenant FKs, ml-scoring's non-owner runtime role, `set_config('app.tenant_id', $1, true)` per transaction; CDC onboarding per README §3 when the DB is created):

| Table | Runtime writes | Retention |
| --- | --- | --- |
| `consumer_inbox` | INSERT | replay horizon |
| `sensor_mounts_view`, `lot_intervals_view`, `lot_samples_view` | INSERT/UPDATE via version-monotone triggers | life of entity |
| `node_window_state` | UPSERT under per-bin lock | rolling 7 d + lateness |
| `feature_online` | UPSERT (pointer to latest revision) | latest only |
| `feature_revisions` | INSERT only, daily partitions by `as_of` | hot 30 d (configurable); older consenting-tenant rows exported per §3.7 before partition drop, gated by an export confirmation watermark (ADR-0011 write-side principle) |
| `ambient_observations` | INSERT; **reference data** keyed by grid cell and hour, no tenant data, on the reviewed non-tenant allowlist (R27); tenant→grid-cell mapping lives in the tenant-scoped `site_weather_cell` | 2 y |

In I1 the offline route reads ambient data from the hashed weather cache files; no database is involved.

Storage estimate (UNMEASURED, R5): ~120 features × 8 B + keys ≈ 1.2 KB per bin row; 96 rows/bin/day ≈ 115 KB/bin/day; Tier 1's 1M devices ÷ 16 ≈ 62.5k bins ≈ 7.2 GB/day before indexes and revisions. I0 recomputes this with the other capacity rows (R5).

### 3.7 Datasets, layout, versioning and splits (R6)

**Two exports, one layout.** Every dataset contains per-bin feature rows **and** a `sequence_windows` export (per-node series at the native 15-min cadence) for I3–I5, plus labels, under one documented layout:

```
<dataset bucket>/<dataset_hash>/
  manifest.json
  bin_features/     tenant=<tenant_pseudonym>/month=YYYY-MM/part-NNNNN.parquet
  sequence_windows/ tenant=<tenant_pseudonym>/month=YYYY-MM/part-NNNNN.parquet
  labels/           tenant=<tenant_pseudonym>/month=YYYY-MM/part-NNNNN.parquet
  parity/           (parity-sample report and send ledger; synthetic tenants only)
```

| Export | Row = | Key columns | Payload columns |
| --- | --- | --- | --- |
| `bin_features` | one bin at one 15-min `as_of`, one revision | `tenant_pk, site_pk, bin_pk, lot_pk, as_of, feature_set_version, revision, feature_row_id` | `fs1` features + `*_missing` indicators, `view`, `data_origin`, `split`, `backfilled_share` |
| `sequence_windows` | one node × one window (context + horizon, lengths in the manifest; multiples of the 8-step I4 patch) | `tenant_pk, bin_pk, device_pk, window_start, window_id` | mount (`cable_label, node_index, depth_m, radial_m`), per-step arrays `observed_at, received_at, temperature_c, relative_humidity_percent, missing_mask, backfilled`; bin-level ambient series; `data_origin`, `split` |
| `labels` | one label interval/point | `tenant_pk, bin_pk, device_pk?, label, start, end` | label attributes (`type` for `fc1` faults, cell/region) |

- **Pseudonymised keys, never dropped:** every tenant, site, bin, lot and device ID is replaced by `HMAC-SHA256(dataset_key, kind ‖ raw_id)` truncated to 128 bits. `dataset_key` is generated per dataset, held in AWS Secrets Manager (KMS-encrypted), never written to the manifest, MLflow or the bucket, and is destroyed with the dataset. Pseudonyms are consistent across the three exports of one dataset and differ between datasets.
- **Partitioned by tenant pseudonym** (then month), so a tenant's data can be deleted by prefix (R26 deletion inventory).
- **Never served to tenants:** no tenant-facing route, signed URL or bucket IAM grant reaches the dataset bucket; tenants see predictions only from the RLS database (I5).
- **No retention lock on tenant data:** object versioning with soft delete only, so deletion and crypto-shred work. A retention lock may be applied only to promoted datasets whose manifest shows `data_origin = synthetic` for every row.
- **Manifest** (`manifest.json`): layout version, feature_set_version, label_spec_version, fault_class_set_version, grain-sim and grain-physics versions, scenario IDs and seeds, weather hashes, tenant pseudonyms with consent scope and consent event version (§3.8), time ranges, view (as-seen/corrected), window lengths, split assignment, row counts, per-file SHA-256, parity report hash; `dataset_hash` = SHA-256 of the canonical manifest. Logged to MLflow as a dataset input and artifact.
- **Real-tenant export** needs `greenguard_ml` (I5) and the consent event (I2). It runs **one RLS transaction per tenant** (`set_config` inside the transaction, ml-scoring's normal non-owner role, job-scoped token per R14). There is **no exporter role with cross-tenant reach**: no BYPASSRLS, no SECURITY DEFINER function, no role that can see two tenants in one transaction.
- Rejected: DVC (a second versioning system next to MLflow + object storage; its Git-coupled workflow adds little when datasets are produced by jobs, not edited by hand).
- **Splits** (all enforced by code, not convention):
  - by **site**: a site is entirely in train, validation or test (sites share weather and management practice);
  - by **time**: rolling-origin folds (see §4.4) with a purge gap ≥ max label horizon (72 h) + max feature window (7 d);
  - by **weather year**: the final test uses weather years never seen in training;
  - by **scenario seed**: no seed in two splits;
  - a small **scenario-family holdout** (e.g. “combined fault + hotspot”) to measure generalisation to unseen combinations.
- **Honest labelling**: every row has `data_origin ∈ {synthetic, real_unlabelled, real_operator_labelled}`. Until real labelled data exists, every model card, API response and dashboard badge says “trained and evaluated on simulated data only”.

### 3.8 Consent (R24)

- Source of truth: `greenguard.tenant.ai_consent.v1` from tenant-control-plane (key `tenant_id`), fields `training ∈ {none, own_tenant, pooled}` (default `none`) and `eval_review: bool` (default `false`), set by an org admin, projected to consumers. Built as an **I2 prerequisite**. (Replaces rev 1's `tenant.ml_consent_changed.v1`.)
- `none`: the tenant's data is never exported. `own_tenant`: exported only into datasets used for that tenant's own models. `pooled`: may join pooled datasets.
- **Floor:** until **≥ 50 real tenants** consent to `pooled`, pooled training uses simulator data only; synthetic tenants do not count toward the floor.
- **Pooled content:** structured features and enums only — **no free-text columns and no agent trajectories**. The export schema allowlist is checked at build time.
- **Cap:** no single tenant contributes more than **10 %** of a pooled dataset's rows (down-sampled deterministically by pseudonym-seeded hash, recorded in the manifest).
- **Poisoning bound:** an adversarial tenant at the cap must not move any other tenant's slice metrics beyond a stated tolerance (test in §6).
- `eval_review` does not affect I1/I2 datasets; it governs human review of AI interactions (R25).
- Revocation: the next dataset build excludes the tenant (consent read at build start and recorded in the manifest); models already trained with its data are handled per open question Q4.

---

## 4. I2 Classical ML ladder

### 4.1 Framing (plain language first)

- **Regression** predicts a number (“the hottest point in this bin will be 27.4 °C in 24 h”). **Classification** predicts a yes/no with a probability (“62 % chance a hotspot starts in the next 72 h”). We need both: the number explains *what* is coming, the probability drives *whether to advise*.
- **Overfitting** is memorising the practice exam instead of learning the subject: great scores on training data, poor on new bins. We detect it by always testing on sites, seasons and weather years the model never saw.
- **Leakage** is accidentally letting the answer into the question — for example a feature computed with a reading that arrived after the prediction time, or the same site in training and test. It makes results look better than reality. §3.1 and §3.7 exist to prevent it; §6 tests it.
- **Calibration** means “when the model says 30 %, it happens about 30 % of the time”. An uncalibrated model can rank bins well yet give probabilities that mislead operators and break advisory thresholds.

ML output is advisory only (R7): the threshold engine remains the alert authority, and nothing here suppresses or changes a threshold alert.

| Task | Target | Unit of prediction | Horizons |
| --- | --- | --- | --- |
| R1 temperature trajectory | max node temperature in bin at t+h (and per-node T at t+h as a secondary task) | bin (node) at as_of t | 6, 24, 72 h |
| R2 quantiles | 10th/90th percentile of R1 | bin | 6, 24, 72 h |
| C1 spoilage-or-hotspot | `spoilage_onset` or `hotspot_onset` in (t, t+h] | bin | 24, 72 h (6 h is too short for actionable lead time; kept as diagnostic) |
| C2 sensor fault | node currently faulty, class ∈ `fc1` (§2.2) | node | now |

Censoring: rows where the bin is already in an onset state at t are excluded from C1 (the question “will it start?” is answered); rows whose horizon crosses the end of the simulated season or a lot change are dropped, not labelled negative.

### 4.2 The ladder

Each rung must beat the rung below on the held-out test by the gates in §7; otherwise the lower rung is the recommended model.

| Rung | Model | Details |
| --- | --- | --- |
| 0a | Persistence | R: T(t+h) = T(t). C: probability = base rate (climatology) |
| 0b | Existing threshold engine | `risk_engine.scoring.assess` with the production policy; alert = `alert_eligible`. Binary, so compared at its single operating point and on lead time |
| 0c | Damped trend | T(t) + slope₂₄ₕ·h·φ (φ fitted) — a cheap “physics-free” trend baseline |
| 1 | Linear / logistic | scikit-learn `Ridge` (per horizon) and `LogisticRegression` with L2 and elastic-net (saga), standardised features, class weights vs none compared; hyperparameters by nested time-split CV |
| 2 | Gradient boosting | **LightGBM** primary (native NaN handling, fast, monotone constraints — e.g. risk non-decreasing in grain temperature and moisture — which makes explanations agree with physics); **XGBoost** as a comparison run; quantile objective for R2; early stopping on the validation fold only |
| 2c | Calibration | Platt (sigmoid) vs isotonic on a separate calibration fold (never the training or test fold); isotonic only if the calibration fold has ≥ 1,000 positives |

Class imbalance: onsets are rare (expected < 2 % of bin-rows, UNMEASURED). Handled by (a) PR-AUC and operating-point metrics instead of accuracy/ROC only, (b) class weights or `scale_pos_weight` compared to unweighted + recalibration, (c) no random oversampling across time (it duplicates correlated neighbours and inflates validation). SMOTE is rejected for time-series windows for the same reason.

### 4.3 Metrics

| Metric | Task | Why |
| --- | --- | --- |
| MAE, RMSE per horizon (°C), skill vs persistence = 1 − MAE/MAE_persist | R1 | direct and interpretable |
| Pinball loss, empirical coverage of the 10–90 interval | R2 | intervals must contain truth ~80 % of the time |
| PR-AUC (average precision) | C1, C2 | rare positives |
| Brier score, Brier skill vs climatology | C1 | probability quality |
| ECE (15 equal-mass bins) + reliability diagram | C1 | calibration |
| Advisory precision/recall at the operating point | C1 | what operators feel |
| False alarms per bin-week | C1 | alert fatigue budget |
| Lead time gained vs threshold engine: median of (first ML advisory − first threshold alert) before the same onset; missed-by-both counted separately | C1 | the business value |
| Event-level recall (an onset counts as caught if any advisory fires in the 72 h before it) | C1 | row-level recall overcounts long episodes |
| False alarms on fault-only scenarios | C1 + C2 | robustness to broken sensors |

Operating point: chosen on the **validation** fold as the lowest threshold with false alarms ≤ **0.5 per bin-week** (owner to confirm, README §8 Q8), then frozen and reported on test.

### 4.4 Backtesting protocol

- Rolling origin with expanding training window: K ≥ 5 folds ordered by weather-year/season; each fold = train → (purge gap) → calibration → (purge) → test.
- Purge/embargo: rows within 72 h + 7 d of a boundary are removed from the earlier side.
- Hyperparameter search runs only inside training folds (nested); the final test set is touched **once per candidate registration** and the number of test evaluations is logged (a “test-set budget” to avoid test-set overfitting).
- Reproducibility: fold definitions are part of the dataset manifest; the backtest is a single command `make ml-backtest DATASET=<hash> MODEL=<config>` that writes every metric and plot to MLflow.

### 4.5 Statistics

- Uncertainty: **cluster bootstrap by site** (resample whole sites with replacement), 2,000 replicates, percentile 95 % CIs. Rows within a site are correlated; row-level bootstrap would give falsely narrow intervals.
- Comparisons: **paired** cluster bootstrap of the metric difference (candidate − baseline) on the same rows; a gate passes only if the CI excludes 0 in the right direction.
- Multiple horizons/tasks: Holm–Bonferroni across the family of gate comparisons.
- Sample size: the test set must contain ≥ **300 onset events** across ≥ **60 sites** — event-level recall then has a 95 % CI half-width of about ±0.06 (1.96·√(0.25/300) ≈ 0.057) before the clustering penalty. If the simulator run does not reach this, the gate is **not evaluated** (reported as insufficient evidence), never waived.
- Slices reported, each with CI: crop, region, weather year, scenario family, `fc1` fault class, aeration on/off, data-quality decile.

### 4.6 Explainability

- Linear: standardised coefficients with CIs from the bootstrap; operator text from a reviewed mapping (`slope_24h_top_layer` → “Top layer warming 0.2 °C per hour over the last day”).
- LightGBM: SHAP `TreeExplainer` with **`feature_perturbation="tree_path_dependent"`** (no background dataset). The interventional mode needs a background sample; a pooled background drawn from other tenants would leak their distributions into explanations, so it is rejected unless the background is synthetic-only.
- Every C1 advisory explanation = top-3 contributing features, each mapped to plain text, plus the threshold engine's reasons for contrast. Additivity check: |Σ SHAP + base − raw margin| < 1e-6 for 100 % of explained rows in tests.
- Global: mean |SHAP| ranking, dependence plots for the top 10, monotonicity check vs physics (e.g. risk must not fall as grain temperature rises, all else equal).

### 4.7 MLflow and promotion (R10)

- Deployment: MLflow 3.x (pin exact version at implementation), backend DB `greenguard_mlflow` (owner ml-platform; MLflow backend only, never raw tenant data), S3 artifact bucket (SSE-KMS), behind OIDC (ALB OIDC authentication or oauth2-proxy); EKS Pod Identity for jobs (backend on RDS for PostgreSQL); no public endpoint.
- Tracking: every run logs git SHA, dataset hash (as `mlflow.data` input), feature_set_version, label_spec_version, fault_class_set_version, config, all fold metrics, CIs, plots (reliability diagram, PR curves, lead-time histogram), environment lockfile, and the `traceparent` of the job span via `packages/otel-py`.
- Registry: one registered model per task (`gg-c1-onset-72h`, `gg-r1-tmax-24h`, …). Stages are deprecated since MLflow 2.9; aliases are used, but **aliases are not the deployment authority**.
- **Authority is Git:** the per-cell deployment manifest in `infra/gitops` (Argo) is the only source of which model version is champion or canary per cohort. Promotion = the promotion job re-runs the §7 gates from logged artifacts, writes a gate report, and opens a PR to the manifest; merging the PR (with the required review) is the promotion. MLflow aliases (`champion`, `canary`) are a **reconciled projection** of the manifest, written only by the I5 reconciler (§4 row “Per-cell deployment manifest + reconciler”). Training jobs may set only `candidate`. Nothing else writes aliases; a hand-set alias is reverted to the Git state and alerted as drift.
- Rollback fast path (I5): flag the cohort to 0 % (seconds) plus an automatic Git revert PR; MLflow is never edited to roll back.
- Model artifact contract: LightGBM native model + `signature` (feature names/dtypes for `fs1`) + imputation/scaler state + calibration map + operating threshold + `feature_set_version`; loading with a mismatched feature set fails closed.
- No tenant rows in MLflow: only aggregate metrics and synthetic-tenant example predictions (MLflow has no tenant model; it is treated as a shared, non-tenant store). Pseudonyms of real tenants are also kept out of artifacts.
- **Model card** (template in `ml/MODEL_CARD.md`, generated and logged): intended use (“advisory, synthetic-trained”), data origin and consent summary, dataset hash, metrics with CIs and slices, operating point, known failure modes (§5), explanation method, owner, review date.

---

## 5. Edge cases and failure modes

| # | Area | Case | Expected behaviour | Test |
| --- | --- | --- | --- | --- |
| 1 | Sim | Same seed run twice | byte-identical emitted stream and labels | S-DET-01 |
| 2 | Sim | Adding one bin to a scenario | other bins' streams unchanged | S-DET-02 |
| 3 | Sim | Unstable time step (high airflow) | step auto-halved; run fails if still unstable, never emits NaN | S-NUM-01 |
| 4 | Sim | Weather API unavailable / rate-limited | use cached hashed file; if absent, fail the run before provisioning or corpus build | S-WX-01 |
| 5 | Sim | Weather file changed upstream | new hash ⇒ new scenario_id; old runs remain reproducible from the stored copy | S-WX-02 |
| 6 | Sim | Moisture outside EMC equation validity range | clamp flagged in labels; scenario marked `out_of_validity` and excluded from gates | S-PHY-03 |
| 7 | Sim | Injector asked for a class not in `fc1` (e.g. `clock_skew`, `cross_wired`) as a sensor fault | configuration rejected; `fc1` is a closed list | S-FLT-01 |
| 8 | Bulk vs parity | Emulator accepts a reading real ingest rejects (or vice versa) | parity gate fails; bulk corpus is not published | S-PAR-01 |
| 9 | Bulk vs parity | Any feature differs between bulk and parity routes for the same scenario | parity gate fails with a per-feature diff report | S-PAR-02 |
| 10 | Parity→ingest | Driver crashes mid-run | resume with same `source_message_id`s; ingest returns original receipts; ledger reconciles to zero duplicates | S-ING-01 |
| 11 | Parity→ingest | 429 burst | honour Retry-After; no reading lost; rejection counter shows `rate_limited`, not a loss | S-ING-02 |
| 12 | Parity→ingest | Device token for wrong node | `device_forbidden`; test asserts it (negative control) | S-ING-03 |
| 13 | Parity→ingest | Readings before binding event is applied | `device_not_ready` 409; driver retries after binding; ledger records it | S-ING-04 |
| 14 | Parity→ingest | Injected out-of-range / future timestamp | expected 422 reason matches the injection 100 % | S-ING-05 |
| 15 | Parity→ingest | Season older than 7 days via live path | rejected `timestamp_too_old`; driver must use the ADR-0025 backfill endpoint | S-ING-06 |
| 16 | Parity→ingest | Backfill request carrying several readings | one transaction and one receipt per reading; a rejected reading does not roll back the others; each stored reading has `backfilled = true` | S-ING-07 |
| 17 | Sim→alerts | Synthetic tenant triggers risk alert | alert recorded as backfilled/synthetic; no notification sent | S-ALR-01 |
| 18 | Backfill→alerts | Real tenant backfills a reading that crosses a threshold | alert recorded as backfilled; no notification | S-ALR-02 |
| 19 | Kernel | Duplicate reading/event | no new revision (kernel is deterministic; online inbox no-op in I5) | F-IDEM-01 |
| 20 | Kernel (I5 online) | Same event ID, different payload | quarantine `event_id_conflict`, offset committed after quarantine | F-IDEM-02 |
| 21 | Kernel | Out-of-order delivery within lateness | same result as ordered delivery | F-LATE-01 |
| 22 | Kernel | Reading after window close | new revision; incremental = batch recompute | F-LATE-02 |
| 23 | Kernel | Store-and-forward burst (hours late) | as-seen view excludes it for earlier as_of; corrected view includes it | F-PIT-01 |
| 24 | Kernel | Lot change between reading observe and delivery | lot selected by observed_at + knowledge time (risk-engine rule) | F-LOT-01 |
| 25 | Kernel | Open lot interval with stale lot feed | not ready; partition paused online, not guessed; quarantine after max wait | F-LOT-02 |
| 26 | Kernel | Unknown grain type | features computed, crop-specific EMC `NULL` + indicator; C1 not scored (mirrors `policy_unavailable`) | F-LOT-03 |
| 27 | Kernel | Missing humidity (only temperature) | dew point/EMC `NULL`, never zero | F-NULL-01 |
| 28 | Kernel | Node with mount unknown | node-level features only; excluded from spatial features; counted | F-MNT-01 |
| 29 | Kernel | Mount changed (cable reinstalled) | features split at `valid_from`; no window spans two mounts | F-MNT-02 |
| 30 | Kernel | Device rebound to another bin | window state reset for the new bin; old bin loses the node from that time | F-BIND-01 |
| 31 | Kernel | Bin with fewer than 16 reporting nodes (dropout, cable break) | coverage feature drops; spatial features over present nodes only; one node ⇒ spatial `NULL` | F-SPA-01 |
| 32 | Kernel | DST / leap second / non-UTC input | all times UTC; window bounds half-open; fixture covers DST dates | F-TIME-01 |
| 33 | Kernel | Feature code change | new `feature_set_version`; old datasets untouched; rebuild via corpus/replay | F-VER-01 |
| 34 | Kernel | Replay produces a different digest for same revision | incident + quarantine; never overwrite | F-VER-02 |
| 35 | I5 online | Tenant/key mismatch in envelope | quarantine before SQL | F-TEN-01 |
| 36 | I5 online | RLS denial (42501) | process stops; never quarantined (same as risk-engine/ADR-0011) | F-TEN-02 |
| 37 | I5 online | Transient DB error / PgBouncer failover | retry with backoff; offset uncommitted | F-DB-01 |
| 38 | I5 online | Missing partition for in-window as_of | fail closed (SQLSTATE 55000), no runtime DDL | F-DB-02 |
| 39 | I5 online | Kafka offset expired | stop (`offset_reset=error`); rebuild via replay driver | F-KAF-01 |
| 40 | Export | Tenant revokes consent mid-export | consent read at build start; revocation after start ⇒ next build excludes; manifest records consent event version | X-CON-01 |
| 41 | Export (I5) | Partition dropped before export confirmation | prevented by export watermark gate | X-RET-01 |
| 42 | Export | `dataset_key` leaks into manifest, MLflow or bucket | build fails (secret scanner over outputs) | X-PSN-01 |
| 43 | Export | Tenant deleted (R26) | prefix `tenant=<pseudonym>/` removed from every dataset; soft-deleted versions purged per deletion ledger; datasets with that tenant marked non-reproducible | X-DEL-01 |
| 44 | Export | Pooled build has < 50 consenting real tenants | real-tenant rows excluded; dataset is synthetic-only and says so | X-CON-02 |
| 45 | Dataset | Same site in train and test | build fails | D-LEAK-01 |
| 46 | Dataset | Feature row with `computed_at` > as_of + serving delay in as-seen view | build fails | D-LEAK-02 |
| 47 | Dataset | Label column name or near-duplicate (|corr| > 0.99) in features | build fails for review | D-LEAK-03 |
| 48 | Dataset | Horizon crosses season end or lot change | row dropped, not negative | D-LAB-01 |
| 49 | Dataset | `sequence_windows` and `bin_features` disagree on keys or time grid | build fails | D-LAY-01 |
| 50 | Training | Fold with zero positives | fold marked insufficient; metrics not averaged over it | T-IMB-01 |
| 51 | Training | Calibration fold too small for isotonic | fall back to Platt; logged | T-CAL-01 |
| 52 | Training | Non-deterministic GBM threads | fixed seeds, `deterministic=true` for LightGBM, CPU; tolerance-based reproducibility check | T-DET-01 |
| 53 | Registry | Model loaded with wrong feature set | fail closed | M-SIG-01 |
| 54 | Registry | Human or job sets `champion` alias directly | denied by registry permissions; if it happens anyway, the reconciler reverts to the Git manifest and raises a drift alert | M-ALIAS-01 |
| 55 | Registry | MLflow down | training job fails without registering; serving follows the Git manifest and loaded artifacts, never MLflow at request time (I5) | M-AVL-01 |
| 56 | Explain | SHAP additivity failure | explanation withheld; threshold-engine reasons still shown | E-SHAP-01 |
| 57 | Sim-to-real | Real tenant data distribution differs | drift monitoring is I5/I12; I2 model card forbids claims beyond synthetic | doc + I5 |
| 58 | Tracing | Python job emits an outbox row without a live span | `packages/otel-py` stores no invented trace ID; with tracing on, `traceparent` is the live span's | O-TRC-01 |

---

## 6. Tenant-isolation tests

| ID | Test | Assertion |
| --- | --- | --- |
| TI-F01 (I5) | Two tenants, same bin/device UUID shapes, interleaved events | each tenant's `feature_online`/`feature_revisions` in `greenguard_ml` contain only its rows; cross-tenant SELECT under ml-scoring's runtime role returns 0 rows for every table **and every partition child** |
| TI-F02 (I5) | Missing `app.tenant_id` | 0 rows visible; INSERT rejected |
| TI-F03 (I5) | PgBouncer reuse | connection used by tenant A then B carries no tenant context (D03 pattern) |
| TI-F04 (I5; kernel fixture in I1) | Kafka key tenant ≠ envelope tenant ≠ payload tenant | quarantined before any SQL (R27 mismatch test) |
| TI-F05 (I5) | Per-bin advisory lock key includes tenant | two tenants with equal bin IDs do not contend |
| TI-X01 | Export with tenants {A: pooled, B: none, C: own_tenant} and floor met | pooled dataset contains only A (+ synthetic); C appears only in C's own-tenant dataset; manifest tenant set == set of tenant pseudonyms actually in the Parquet files |
| TI-X02 | No cross-tenant exporter | no role in `greenguard_ml` has BYPASSRLS; no SECURITY DEFINER function exists; every export transaction sets exactly one tenant; effective-privilege query asserted in CI |
| TI-X03 | Consent revocation | next dataset excludes tenant; revocation ledger links to affected dataset hashes |
| TI-X04 | Pseudonymisation | no raw tenant/site/bin/lot/device UUID in any Parquet file or manifest; the same raw ID gets different pseudonyms in two datasets; `dataset_key` unreadable by training jobs' identity |
| TI-X05 | Consent floor, cap, content, poisoning | < 50 pooled real tenants ⇒ no real rows; no tenant > 10 % of pooled rows; schema contains no free-text or trajectory columns; an adversarial tenant at the cap does not move any other tenant's slice metrics beyond tolerance |
| TI-X06 | No Parquet served to tenants | no tenant principal, route or presigned S3 URL can read the dataset bucket (IAM and bucket-policy test + API route scan) |
| TI-S01 | Parity-sample machine client for tenant A tries tenant B resources | 403/404 indistinguishable from not-found |
| TI-S02 | Labels | label files sit under the correct tenant pseudonym prefix only; a dataset build for tenant A's own-tenant model reads no other prefix |
| TI-M01 | MLflow artifacts scan | no real-tenant IDs, pseudonyms or rows in any artifact (CI scanner: UUIDs must belong to synthetic tenants) |
| TI-E01 | SHAP explanation for tenant A's advisory | computed from tenant A's feature row only; no background dataset from other tenants |
| TI-W01 (I5) | Ambient reference data | contains grid cells only; `site_weather_cell` (tenant → cell) is RLS-protected; a tenant cannot enumerate other tenants' cells |

Note on pooled models: a model trained on several tenants is itself a mild channel between tenants (membership inference). For bin-level structured features the risk is low, but it is why pooled training is opt-in, capped per tenant, limited to structured features, and closed to real tenants until the floor is met.

---

## 7. Acceptance gates

### I1 gates

| Gate | Sample | Metric | Threshold |
| --- | --- | --- | --- |
| I1-G1 Determinism | 50 scenarios × 2 runs | emitted-stream SHA-256 equality | 100 % |
| I1-G2 EMC correctness | all ASABE table points for wheat, canola, corn, barley | abs error vs published EMC | ≤ 0.3 pp moisture |
| I1-G3 Energy balance | 20 closed-bin runs, no aeration | energy closure error | ≤ 1 % |
| I1-G4 Qualitative physics | named scenario tests | cooling front reaches top within expected airflow-based time ±20 %; winter top-centre condensation appears; wet pocket self-heats | all pass |
| I1-G5 Ingest reconciliation | parity sample (~20 bin-seasons) through real ingest | sent = accepted + Σ rejected-by-reason; rejected reasons match injections; emulator decisions = real ingest decisions | 100 %, 0 unexplained |
| I1-G6 Point-in-time | full training dataset | rows violating event-time or knowledge-time rule | 0 |
| I1-G7 Bulk/real parity (R4) | every (entity, as_of) of the parity sample | max abs diff, bulk route vs kernel on canonical events | ≤ 1e-9 and identical NULL pattern; repeated in I5 against the ml-scoring online path |
| I1-G8 Order independence | 200 bin-days with shuffled delivery within lateness + late bursts | incremental final revision = batch recompute | 100 % |
| I1-G9 Rebuild | rebuild of `fs1` dataset from the same scenarios, seeds and weather hashes | dataset content hash | identical |
| I1-G10 Leakage and layout checks | every dataset build | D-LEAK-01..03, D-LAY-01 | all pass (CI-enforced) |
| I1-G11 Tenant isolation | §6 TI-X01..06, TI-S*, TI-M01 (TI-F*/TI-W01 are I5 gates) | pass | 100 % |
| I1-G12 Fault classes | injector config and labels | every labelled `sensor_fault.type` ∈ `fc1`; list published for I11 | 100 % |
| I1-G13 Contract changes | README §4 rows assigned to I1 (device-service events, `tenant.synthetic`, backfill endpoint, notification suppression, `packages/otel-py`) | each row's exit test | pass |
| I1-G14 Backfill | ADR-0025 endpoint | one receipt per reading, `backfilled = true` stored, no notification for synthetic tenant or backfilled reading | 100 % |
| I1-G15 Throughput (UNMEASURED target) | bulk corpus of 100 bin-seasons; full parity sample | readings/s through the offline kernel; readings/s and feature lag p95 through real ingest | recorded as evidence; targets set after first measurement |

### I2 prerequisite and gates (held-out test: unseen sites + weather years; ≥ 300 onsets, ≥ 60 sites)

Prerequisite: `greenguard.tenant.ai_consent.v1` exists with its event contract and revocation tests (README §4), and TI-X05 passes.

| Gate | Metric | Threshold (with 95 % paired cluster-bootstrap CI, Holm-corrected) |
| --- | --- | --- |
| I2-G1 Regression skill | MAE of chosen model vs persistence at 6/24/72 h | MAE ≤ 0.8 × persistence and CI of difference < 0, each horizon |
| I2-G2 Interval coverage | 10–90 % interval coverage | 0.75–0.85 |
| I2-G3 Ranking | PR-AUC of C1 (72 h) vs logistic rung | CI of difference > 0 (else logistic is chosen) |
| I2-G4 Beat the threshold engine | event-level recall at operating point with ≤ 0.5 false alarms/bin-week | recall ≥ threshold-engine recall + 0.10, CI lower bound > 0 |
| I2-G5 Lead time | median lead time gained vs threshold engine | ≥ 12 h, CI lower bound > 0 |
| I2-G6 Calibration | ECE (15 equal-mass bins) | ≤ 0.05; Brier skill vs climatology > 0 |
| I2-G7 Fault robustness | false alarms/bin-week on fault-only scenarios | ≤ 2 × clean-scenario rate and ≤ threshold engine's rate |
| I2-G8 Slices | every crop and region slice with ≥ 30 onsets | no slice recall below overall − 0.15 without a documented reason in the model card |
| I2-G9 Sensor-fault classifier (C2) | PR-AUC per `fc1` class | ≥ 0.8 for `stuck`, `drift`, `dropout`; reported for `offset`, `noise`, `spike`, `cable_break` |
| I2-G10 Explainability | SHAP additivity, plain-text mapping coverage | 100 % / 100 % of features |
| I2-G11 Reproducibility | retrain from logged dataset hash + config | metrics within ±1 % relative |
| I2-G12 Governance | each registered version | has dataset hash, git SHA, model card, gate report; only `candidate` set by jobs; champion/canary exist only via a merged Git manifest PR (R10) |

Thresholds are initial proposals for owner confirmation (README §8 Q8); any change after seeing test results requires an ADR note so the gate is not tuned to the answer.

---

## 8. Senior topics covered

Physics-informed simulation and sim-to-real honesty; deterministic seeded generation; bulk synthetic generation with a real-pipeline parity gate; bitemporal point-in-time correctness (event time vs knowledge time); watermarks, allowed lateness, recompute and revisions; online/offline feature parity through one kernel; feature and dataset versioning with content hashing; pseudonymised, tenant-partitioned dataset layout for tabular and sequence models; exactly-once *effect* via inbox + deterministic IDs in an ML pipeline; leakage-proof splitting (group, time, purge/embargo, weather-year holdout); consent-gated pooled training under RLS without BYPASSRLS, with floor, cap and poisoning tests; problem framing (regression vs classification, horizons, censoring); baseline discipline (persistence, production rules); regularisation, calibration (Platt/isotonic, ECE, reliability); gradient boosting with monotone constraints; quantile regression; class imbalance without leakage; rolling-origin backtesting with nested tuning and a test-set budget; cluster/paired bootstrap, Holm correction, power/sample-size reasoning; operating-point selection against an alert-fatigue budget; lead-time as a business metric; SHAP with tenant-safe settings; MLflow tracking, GitOps-owned promotion with aliases as a projection, model cards.

## 9. ADRs to write (numbering per R30)

Decided numbers: **ADR-0025** backfill ingest path (amends ADR-0006; R32). Consent follows **R24** and ships with the I2 consent event. Others get numbers ≥ 0029 when written:

1. Sensor node as device (R5); mount metadata owned by device-service (`device.mount_changed.v1`).
2. Lot samples (`lot.sample_recorded.v1`), site location (0.1° rounding), bin geometry (`site/bin.changed.v2`).
3. ADR-0025 backfill ingest path: role, age limit (README §8 Q6), rate bucket, one reading per receipt, `backfilled` flag, no-notify rule.
4. Synthetic tenants and notification suppression for synthetic/backfilled readings.
5. Feature kernel and storage: `packages/ml-features`, online state in `greenguard_ml`, Parquet snapshots; Feast/Cassandra/Redis/SageMaker Feature Store rejected; revision model.
6. Bitemporal point-in-time rule and as-seen vs corrected views.
7. Training corpus: bulk simulator route, ingest-rule emulator and real-ingest parity gate (R4).
8. Dataset layout: `bin_features` + `sequence_windows` + `labels`, HMAC pseudonyms, tenant-pseudonym partitioning, no retention lock on tenant data (R6).
9. Weather source and licence (README §8 Q7).
10. Label specification v1 (DML 0.5 %, hotspot 5 °C / 6 h), censoring rules, and fault class set `fc1`.
11. Evaluation and promotion protocol (splits, gates, statistics, test-set budget, Git-manifest promotion per R10).
12. MLflow deployment, access control and “no tenant rows in MLflow”.
13. CO₂ measurement contract (deferred, coordinated v2).

## 10. Claude skills to load when implementing

`ecc-mle-workflow`, `wshobson-ml-pipeline-workflow`, `wshobson-data-quality-frameworks`, `wshobson-evaluation-methodology`, `wshobson-backtesting-frameworks`, `ecc-python-patterns`, `ecc-python-testing` / `wshobson-python-testing-patterns`, `ecc-postgres-patterns` / `wshobson-postgresql-table-design`, `ecc-database-migrations`, `wshobson-projection-patterns` (inbox/replay), `wshobson-architecture-decision-records`, `wshobson-gdpr-data-handling` (consent/revocation/pseudonymisation), `wshobson-dataset-curation`, `superpowers-test-driven-development`, plus the repo agents `architecture-guard` and `tenant-isolation-reviewer`.

## 11. Open questions for the owner

Resolved by the README and removed: backfill alert suppression (R32: never notify), consent model (R24), sensor cadence (R5). Remaining:

- Q1 Accept “one cable node = one device” and inventory-owned mount metadata (G1)? (R5 fixes the device model; the mount contract still needs approval.)
- Q2 Backfill maximum age — README §8 Q6 (proposal 400 days).
- Q4 On consent revocation, must models trained with that tenant's data be retired (by when), or only excluded from future training?
- Q5 Alert-fatigue budget (0.5 false alarms per bin-week), gate thresholds in §7 and label thresholds (0.5 % DML, 5 °C/6 h) — README §8 Q8.
- Q6 Weather source for production — README §8 Q7.
- Q8 Poisoning tolerance for TI-X05 (proposal: no other tenant's slice recall moves by more than 0.02 absolute).

Sources checked: Open-Meteo licence/terms (CC BY 4.0 data; free API non-commercial), MLflow docs (stages deprecated since 2.9, aliases), Feast docs (Postgres offline/online store is contrib; point-in-time `get_historical_features`).
