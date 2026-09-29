# GreenGuard Intelligence — I3 Deep learning in PyTorch, I4 Time-series transformer from scratch, I5 Online ML serving and MLOps

Status: DESIGN DRAFT rev 2 (2026-09-29), conformed to the binding [README](README.md) §2 (R1–R32), §3 name registry, §4 changes table and §5 stage table. Where this file and the README disagree, the README wins. Nothing in this section is built. Every capacity figure is **UNMEASURED** until Stage I13 evidence exists.

Grounding read for this section: `services/risk-engine/README.md`, `risk_engine/scoring.py`, `risk_engine/events.py`, `risk_engine/apply.py`, `contracts/events/risk-assessed.v1.schema.json`, `contracts/events/risk-assessment-invalidated.v1.schema.json`, `contracts/events/telemetry-recorded.v1.schema.json`, `services/workflow-alerts/README.md`, `docs/CAPACITY_MODEL.md` (lines 16–55), ADR-0002/0008/0009.

Facts from the existing system that this design depends on:

- `risk-engine` owns `greenguard_risk`. It does the event-time lot join (reading at `observed_at` → covering `[effective_from, effective_to)` lot interval), scores with a **deterministic integer threshold policy** (`scoring.py`: 0/25/50 points per metric, `score ≥ 75` critical, `score ≥ alert_score` warning), and writes `risk_assessments` + a `risk.assessed` outbox row in one tenant transaction. IDs are UUIDv5 of `(tenant, source_event_id, lot_id, policy_version)`.
- The `risk.assessed` event type is carried on the topic **`greenguard.risk.assessment.v1`**; invalidations (`risk.assessment_invalidated`) on **`greenguard.risk.assessment_invalidated.v1`**. There is no `risk.assessed.v1` or `telemetry.canonical.v1` topic (R3). The payload is `assessment_id, assessment_version, device_id, reading_id, source_event_id, bin_id, lot_id, grain_type, occupancy_version, policy_version, score, severity, alert_eligible, reasons` — it carries **no sensor values**, which is why ml-scoring also consumes telemetry.
- `workflow-alerts` owns `greenguard_alerts`; opens an episode at score ≥ 40 with an alert-eligible severity, resolves below 25 (hysteresis), escalates once after 15 min. Backdated lot placement emits `risk.assessment_invalidated`, which can resolve an episode. `workflow-alerts` does **not** consume ML predictions (R8).
- Canonical telemetry has **six partitions**; one consumer group can have at most six active consumers, each needing ≥3,333 events/s normal and ≥8,333 events/s peak at Tier 1 (CAPACITY_MODEL lines 54–55). Tier U fleet rate is 1,666,667 events/s normal. All UNMEASURED, and I0 recomputes them from the R5 sensor model below.

**Sensor model (R5, one decision used everywhere in this file).** One cable node = one device. A reference bin has 4 cables × 4 depths = **16 devices**. Each device reports every **15 minutes**. The feature and forecast grid is **15 minutes per bin**. The I4 patch is **8 steps = 2 hours**. A day is therefore 96 steps per device.

---

## Plain-language primer (read this first)

| Term | Plain explanation | Where it shows up |
| --- | --- | --- |
| Tensor | A box of numbers with a shape. A single reading is shape `[2]` (temperature, humidity). A day of 15-minute readings for the 16 devices of a reference bin is `[96, 16, 2]`. A batch of 256 such days adds a front dimension: `[256, 96, 16, 2]`. The GPU is fast because it does the same arithmetic on the whole box at once. | Every I3/I4 model input |
| Loss | One number that says "how wrong were we". Lower is better. For a forecast, mean squared error is the average of (prediction − truth)². | Training loop |
| Gradient | For each weight, "if I nudge this weight up a tiny bit, how much does the loss change, and in which direction?" | Backprop |
| Autograd / backprop | PyTorch records every operation as you compute the loss, then walks that record backwards applying the chain rule to get every gradient in one pass. You write the forward maths; the backward maths is automatic. The micro-autograd lab builds this by hand for scalars so it stops being magic. | I3 lab 1 |
| Optimizer | The rule that turns gradients into weight changes. SGD: step downhill by `lr × gradient`. Adam/AdamW: keeps a running average of each weight's gradient and its size, so noisy or rarely-updated weights get sensible step sizes. AdamW also shrinks weights slightly each step (weight decay) to avoid overfitting. | Training loop |
| Learning-rate schedule | Change the step size over time: warm up small, go big, then cool down so the model settles. | Every run |
| Overfitting / regularisation | Memorising the training bins instead of learning grain physics. Dropout, weight decay, early stopping and more data fight it. | Every run |
| Quantile forecast | Instead of "it will be 24 °C", say "10% chance below 22, median 24, 10% chance above 27". The pinball loss trains each quantile to be right the stated share of the time. | LSTM/TCN/transformer heads |
| Autoencoder | A network forced to squeeze a window of readings through a narrow bottleneck and rebuild it. Trained only on normal data, it rebuilds normal windows well and strange ones badly; the rebuild error is an anomaly score. | Sensor-fault vs hotspot |
| Attention | Each time step asks "which other time steps matter for me?" and takes a weighted average of them. The weights are the attention map. | I4 |
| Shadow mode | The new model runs on real traffic and its answers are written to a private table, but they are never published as events, so nothing a customer sees changes. | I5 |
| Canary | Let a small, chosen group of tenants see the new model's output, watch safety metrics, widen or roll back. The group is picked by a feature flag inside ml-scoring. | I5 |
| Drift | Today's inputs or outputs no longer look like the data the model learned from (new sensor firmware, new crop, a heat wave). | I5 |
| Watermark | A note saying "every reading up to here has been scored". A reader compares it with the clock to know whether predictions are fresh, instead of guessing from the last prediction it happened to see. | I5 |
| Material change | We only announce a new prediction when it differs enough from the last announced one (for example the anomaly state flips). Every prediction is still stored; only the announcement is skipped. | I5 |
| Deployment manifest | A file in Git that says which model version is champion and which is canary. Changing it is a reviewed commit; undoing it is a revert. | I5 |

---

## Cross-section assumptions (other sections must agree)

1. **I1 data contract (R2, R4, R6).** I1 delivers `packages/ml-features` — **one feature kernel** used offline and online — and the **offline** corpus only. The corpus is one documented Parquet layout with two exports: per-bin feature rows, and a **`sequence_windows`** export (per-node series at the native 15-minute cadence) that I3–I5 train from. Keys are **pseudonymised with a per-dataset HMAC** (`tenant_pseudonym, bin_key, device_key, window_end`), never dropped; files are partitioned by tenant pseudonym; an `as_of` column proves no future leakage. Parquet is never served to tenants. There is **no I1 online feature store**: the online window state is owned by `ml-scoring` in `greenguard_ml` and built in I5 by ml-scoring's own streaming consumer, calling the same `packages/ml-features` kernel. I3–I5 never write their own feature code.
2. **Parity sample (R4).** About 20 bin-seasons are pushed through the real path (telemetry-ingest → CDC → ml-scoring online consumer) and must produce features identical to the simulator's direct Parquet output. It is an I1/I5 gate (G5.18). Bulk training data never goes through ingest.
3. **I2 backtesting harness** defines the rolling-origin folds, the seasonal-naive and gradient-boosting baselines, and the metric library (MASE, pinball, CRPS approximation, interval coverage, PR-AUC). I3/I4 reuse those folds unchanged so numbers are comparable.
4. **MLflow** (I2) is the tracking server and artifact registry (`greenguard_mlflow`, never raw tenant data). It is **not** the deployment authority: which version is champion or canary per cohort is decided only by the per-cell deployment manifest in `infra/gitops` (R10). MLflow aliases (`@champion`, `@canary`) are a projection that a reconciler keeps equal to Git; nothing else writes them.
5. **I9/I12** own the evaluation dashboards and full AI/ML observability stack. Because I12 comes after I5, I5 must itself ship the **minimum metrics and alert rules** that automatic rollback needs, or keep promotion manual until I12 (README §5; see D5.11).
6. **Stage 10 feature flags** (OpenFeature, GG-10b) are evaluated **inside ml-scoring** to pick a tenant's cohort; they are the canary mechanism (R10).
7. **Labels.** Forecast labels arrive automatically once the horizon passes (the future reading is the truth). Anomaly labels come from (a) simulator-injected faults/hotspots (I1), (b) the operator's **alert verdict on acknowledge** recorded by workflow-alerts, if the owner answers README §8 Q10 yes (README §4 row).
8. **Consent (R24).** Which tenants' data may train which model follows `greenguard.tenant.ai_consent.v1` (`training ∈ {none, own_tenant, pooled}`, default `none`). See D5.14.

---

## I3 — Deep learning in PyTorch

### Goals

Build the fundamentals by hand, then two production forecasters (LSTM, TCN) and one anomaly model (autoencoder + fault/hotspot classifier) that beat the I2 gradient-boosting baseline or are honestly reported as not beating it.

### Layout

```
ml/
  labs/                 # teaching code; tested, never deployed
    micro_autograd/     # scalar Value class, topological backward, tiny MLP
    gradcheck/          # finite-difference checks vs torch.autograd
    training_loop/      # hand-written loop, then the same with Lightning-free helpers
  greenguard_ml/        # production package (pinned, typed, 80%+ coverage)
    data/               # WindowDataset, samplers, collate, normalisation stats
    models/             # lstm.py, tcn.py, autoencoder.py, heads.py
    losses/             # pinball, focal, weighted BCE
    train/              # trainer, early stopping, AMP, determinism, checkpointing
    tune/               # Optuna studies
    export/             # ONNX export + parity tests
```

### Labs (built and tested, part of the acceptance)

| Lab | What is built | Test that proves understanding |
| --- | --- | --- |
| L1 micro-autograd | `Value` with `+ * ** tanh exp relu`, `_backward` closures, topological sort, `backward()`; a 2-layer MLP trained on a toy grain-temperature regression | Gradients match `torch.autograd` on 200 random expression graphs (fp64, rel. error < 1e-9) |
| L2 gradient check | Central finite difference `(f(x+h) − f(x−h)) / 2h` for custom `pinball_loss`, `focal_loss`, a custom causal conv | `torch.autograd.gradcheck` passes in fp64; our own checker agrees to < 1e-6 relative |
| L3 training loop | Manual loop: `zero_grad → forward → loss → backward → clip_grad_norm_ → step → scheduler.step`; then show each bug class: forgotten `zero_grad`, `model.train()` vs `eval()` with dropout, leakage from fitting the scaler on all data | Each deliberately broken variant is detected by a test (loss curve or metric assertion) |
| L4 tensors on devices | Same model on CPU, Apple MPS, CUDA; `.to(device)`, dtype, `pin_memory`, non-blocking copies | Outputs agree across devices within documented tolerance (fp32 atol 1e-4) |

### Data pipeline

- `WindowDataset(feature_set_version, split, context_len, horizons)` reads I1's **`sequence_windows`** Parquet export (R6) via `pyarrow.dataset`, builds windows lazily per `(tenant_pseudonym, bin_key)` series at the 15-minute native cadence (96 steps per day, 16 devices per reference bin, R5), and returns `x[context, sensors, features]`, `y[horizons, sensors, targets]`, `mask` (missing readings), `meta` (tenant pseudonym, bin key, window_end — never fed to the model). Real tenant IDs never appear in training data; only HMAC pseudonyms do.
- Only tenants whose consent allows it are in the export (R24, D5.14). Until ≥ 50 tenants consent to `pooled`, I3/I4 train on simulator data only.
- **Splits are by time first, then by bin group.** Rolling-origin folds from I2; within a fold, 10% of bins are held out entirely to measure generalisation to unseen bins (cold start). Random shuffling of windows across time is forbidden — adjacent windows overlap and would leak.
- Normalisation statistics are fit on the training slice of each fold only, stored as a versioned artifact in MLflow, and exported with the model.
- Missing data: masks, not zeros (mirrors `scoring.py`: "absent inputs are never read as zero"). Loss is masked.
- `DataLoader(num_workers>0, persistent_workers=True, pin_memory=True on CUDA, worker_init_fn=seed_worker, generator=g)`.
- Class imbalance for anomaly labels handled by a `WeightedRandomSampler` **or** loss weighting, never both (double-counting is a tested bug).

### Models

| Model | Architecture | Output | Why |
| --- | --- | --- | --- |
| LSTM forecaster | 2-layer LSTM, hidden 64–256, over per-timestep embeddings of `[sensors × features]` plus calendar and lot features (grain type embedding, days-in-storage); direct multi-horizon head (no autoregressive rollout) | Quantiles {0.1, 0.5, 0.9} for horizons {6 h, 24 h, 72 h} per sensor | Classic recurrent baseline; direct heads avoid error compounding |
| TCN forecaster | Dilated causal 1-D convolutions (dilations 1,2,4,…,64), residual blocks, weight norm | Same | Parallel over time, stable gradients, receptive field is explicit and testable |
| Quantile head | Predict median + softplus-positive increments so q0.1 ≤ q0.5 ≤ q0.9 by construction | Monotone quantiles | Rejected alternative: sort after prediction (hides crossing, breaks gradients) |
| Autoencoder | 1-D conv encoder/decoder over 24 h windows (96 steps) of all 16 devices in a bin, trained only on windows labelled normal | Per-sensor, per-timestep reconstruction error | Unsupervised; works before labels exist |
| Fault-vs-hotspot classifier | Small MLP over autoencoder error features + cross-sensor consistency features (neighbour correlation, humidity co-movement, rate-of-change, stuck-at/flatline, spike, physical-range proximity) | 3 classes: `normal`, `sensor_fault`, `hotspot` | The domain question: a lone sensor jumping 15 °C in one reading is a fault; neighbouring sensors rising together over hours with humidity is a hotspot |

Why TCN and LSTM both: the LSTM teaches recurrence and its failure modes (vanishing gradients, clipping); the TCN is the one more likely to ship (faster ONNX inference, deterministic receptive field).

### Losses (each implemented, unit-tested, gradient-checked)

| Loss | Used for | Note |
| --- | --- | --- |
| MSE | Lab baseline, point forecast | Punishes large errors; implies mean prediction |
| Pinball / quantile | All forecasters | `max(q·e, (q−1)·e)`; averaged over quantiles/horizons with masking |
| BCE with `pos_weight` | Binary hotspot head in the ablation | `pos_weight = neg/pos` from the training slice only |
| Cross-entropy with class weights | 3-class classifier | |
| Focal (γ=2, α per class) | 3-class classifier ablation | Compared to weighted CE; keep whichever wins on PR-AUC at the fixed operating point |

### Training mechanics

- Optimizers: AdamW (default), SGD+momentum (ablation). Schedules: linear warm-up + cosine decay; `ReduceLROnPlateau` ablation. `clip_grad_norm_(1.0)` always for LSTM.
- Regularisation: dropout, weight decay, early stopping on validation pinball (patience 10 epochs, restore best checkpoint).
- Mixed precision: `torch.autocast` with **bf16** on CUDA (no GradScaler needed); fp16 + `GradScaler` only as a documented lab. MPS autocast support is version-dependent — verify at build time and fall back to fp32 on MPS if unsupported. CPU trains in fp32.
- Reproducibility: `seed_everything(seed)` (python, numpy, torch, CUDA), `torch.use_deterministic_algorithms(True)`, `CUBLAS_WORKSPACE_CONFIG=:4096:8`, seeded DataLoader generator; record `torch.__version__`, CUDA/cuDNN versions, device name, git SHA, lockfile hash, feature-set version and data snapshot digest in MLflow. Reproducibility claim: bit-identical on CPU; within tolerance on GPU (documented, because some kernels have no deterministic implementation).
- Hardware: CPU for tests/CI; MPS for local iteration; EKS g6 (L4) GPU NodePool (Spot via Karpenter, On-Demand fallback; see I6 B5) for full training via the I5 pipeline. Device selection is a config parameter, never auto-magic inside library code.
- Hyperparameter search: Optuna TPE sampler + `MedianPruner`, study storage in Postgres, each trial a nested MLflow run; search space: hidden size, layers, dropout, lr, weight decay, context length, TCN kernel size. Budget fixed (e.g. 60 trials) and reported; the chosen trial is retrained on train+val and evaluated once on the untouched test fold.
- Experiment tracking: MLflow params, per-epoch metrics, loss curves, artifacts (normalisation stats, ONNX, model card, golden inputs/outputs).
- Export: ONNX via `torch.onnx.export` (verify dynamo vs legacy exporter default for the pinned PyTorch), opset pinned, dynamic batch axis; parity test PyTorch vs ONNX Runtime on 1,000 golden windows. TorchScript is covered only as a lab comparison (it is in maintenance mode upstream); the served format is ONNX. Optional INT8 dynamic quantisation of the TCN/MLP evaluated for CPU serving with an accuracy-loss budget.

### I3 edge cases and failure modes

| # | Case | Expected handling | Test |
| --- | --- | --- | --- |
| 3.1 | Series shorter than context length (new bin) | Left-pad with mask; if observed fraction < 25% of context → sample excluded from training, `insufficient_history` at serving | Dataset unit test |
| 3.2 | Gaps from sensor outage | Mask, never zero-fill; loss masked | Loss equals loss on the unmasked subset |
| 3.3 | Lot change inside a window (wheat→canola) | Window split at `effective_from`; windows never span two lots for training targets | Fixture from risk-engine join semantics |
| 3.4 | Backdated lot placement invalidates earlier context | Feature snapshot versioned; training uses the corrected `as_of` view | Point-in-time test against I1 |
| 3.5 | NaN/Inf in loss | Trainer stops the run, logs the batch indices, marks MLflow run FAILED; no silent skip | Inject NaN input |
| 3.6 | Exploding LSTM gradients | Grad-norm logged; clipping; test that clipping bounds norm | Unit |
| 3.7 | Quantile crossing | Impossible by construction; assertion in eval | Property test |
| 3.8 | Class imbalance collapse (always predicts normal) | Macro PR-AUC gate fails the run | Gate |
| 3.9 | Label leakage via normalisation over full data | Stats fit on train slice only; test compares against deliberately leaky variant | L3 lab |
| 3.10 | Temporal leakage through overlapping windows across split boundary | Gap of `context + max_horizon` between train and val | Dataset boundary test |
| 3.11 | Tenant dominates data (one huge tenant) | Per-tenant share capped at ≤ 10% of pooled training rows (R24); report metrics per tenant-size decile | Sampler test |
| 3.12 | Non-determinism across runs | Deterministic flag; CPU runs hash-identical | Two-run weight hash test |
| 3.13 | MPS op unsupported | Explicit fallback to CPU with a warning recorded in MLflow; never silent | Device test |
| 3.14 | ONNX export diverges (unsupported op, dynamic shape) | Parity test fails the pipeline; model not registered | Export test |
| 3.15 | Simulator-only training fails on real sensors | Model card states "trained on synthetic data"; I5 shadow is mandatory before any canary | Process gate |
| 3.16 | Hotspot and fault co-occur (hotspot damages sensor) | Classifier emits both probabilities; alerting side treats `hotspot` probability independently of `sensor_fault` | Simulator scenario |
| 3.17 | Optuna overfits validation fold | Final test fold touched once; reported separately | Process + MLflow tag `test_evaluated_once` |

### I3 acceptance gates

| Gate | Sample | Metric | Threshold |
| --- | --- | --- | --- |
| G3.1 micro-autograd | 200 random graphs | max relative gradient error vs torch (fp64) | < 1e-9 |
| G3.2 custom losses | pinball, focal, weighted BCE | `gradcheck` fp64 | pass |
| G3.3 forecast skill | I2 folds (≥5 rolling origins), ≥2,000 simulated bins, ≥90 days each | MASE at 24 h vs seasonal-naive | ≤ 0.90 (TCN or LSTM) |
| G3.4 vs gradient boosting | same folds | mean pinball, Diebold–Mariano test | report win/loss honestly; ship DL only if pinball ≤ GBM and DM p < 0.05, else GBM remains champion |
| G3.5 calibration | same folds | empirical coverage of 80% interval | 0.75–0.85 per horizon |
| G3.6 fault vs hotspot | simulator hold-out, ≥500 injected hotspots, ≥500 injected faults, ≥50k normal windows | hotspot recall at ≤5% fault→hotspot confusion; macro PR-AUC | recall ≥ 0.90; PR-AUC ≥ 0.85 |
| G3.7 reproducibility | 2 CPU runs, same seed | weight SHA-256 | identical |
| G3.8 export parity | 1,000 golden windows | max abs diff PyTorch vs ONNX Runtime (fp32) | ≤ 1e-4; INT8 ≤ 2% pinball degradation |
| G3.9 unseen-bin generalisation | held-out 10% bins | MASE ratio held-out / seen | ≤ 1.15 |

---

## I4 — Time-series transformer from scratch

### Design decision: PatchTST-style encoder with channel independence (primary), causal decoder (lab)

- **Primary:** encoder-only transformer over **patches** (patch length **8 steps = 2 h** at the R5 15-minute cadence, stride 4 steps = 1 h), each sensor-channel processed independently with shared weights (channel independence), RevIN-style instance normalisation, direct multi-horizon quantile head (same head as I3). Reasoning: with stride 4, patching cuts sequence length ~4× (a 7-day context goes from 672 steps to ~167 patches), so attention cost (quadratic in length) drops ~16×; channel independence generalises across bins with different sensor counts and is a strong published baseline for multivariate forecasting.
- **Lab:** a decoder-only causal variant (GPT-style next-patch prediction) to teach causal masking and autoregressive generation; compared, not shipped unless it wins.
- **Rejected:** per-timestep tokens as the primary (96-token days, 672 tokens for a week of context, quadratic cost, weak at this data size); Informer/Autoformer-style sparse attention (complexity not justified at our context lengths); fine-tuning a foundation model as the primary (the owner goal is to build it; foundation models become a baseline).
- Cross-sensor (spatial) mixing is added as an ablation: a second attention over sensors within the same bin after temporal encoding, to test whether hotspot detection improves when sensors "see" neighbours.

### Components written by hand (no `nn.Transformer`, no `nn.MultiheadAttention` in the model)

| Component | Implementation | Test |
| --- | --- | --- |
| Patch embedding | unfold → linear projection to `d_model` | shape + inverse (fold) test |
| Positional encoding | sinusoidal (fixed) and learned (ablation) | sinusoid values vs closed form; relative-offset property |
| Scaled dot-product attention | `softmax(QKᵀ/√d_k + mask) V`, additive `-inf` masks, dropout | **Parity vs `torch.nn.functional.scaled_dot_product_attention`** on 1,000 random `(batch, heads, L, d)` shapes, with and without `is_causal`, boolean and float masks, fp64 atol 1e-10 and fp32 atol 1e-6 (dropout 0) |
| Multi-head attention | fused QKV linear, reshape to heads, attention, concat, output projection | parity vs `nn.MultiheadAttention` with copied weights |
| Causal mask | upper-triangular `-inf` | **Future-perturbation test**: change inputs at positions > t; outputs at ≤ t unchanged exactly |
| Padding mask | key padding for missing patches | fully-masked row yields zeros, never NaN (explicit guard; a known softmax pitfall) |
| LayerNorm | mean/var over last dim, learnable γ β | parity vs `nn.LayerNorm` |
| Pre-norm residual block | `x + Attn(LN(x))`, `x + FFN(LN(x))`, GELU FFN | gradient-flow test at depth 12 |
| Batch invariance | model output for row i independent of other rows | tenant-isolation test T-I4 below |

### Explanations

- Attention maps per layer/head and **attention rollout** rendered as a heatmap over patches ("the model looked mostly at the last 6 hours and at yesterday afternoon").
- Because attention weights are not a faithful explanation on their own, every explanation is paired with **occlusion** (mask a patch, measure forecast change) and **integrated gradients** (Captum) on the input. A test asserts the top-3 patches by occlusion and by rollout are reported side by side; disagreement is shown, not hidden.
- Explanations are computed offline or on-demand for a specific prediction (not inline at scale), stored tenant-scoped, and exposed later to the I7/I8 agent as a tool.

### Comparison protocol (same I2 folds, same features)

Models: seasonal-naive, I2 gradient boosting, I3 LSTM, I3 TCN, I4 PatchTST-from-scratch, I4 causal decoder, foundation-model zero-shot. Metrics: MASE, mean pinball, weighted interval score (CRPS approximation), 80% coverage, hotspot early-warning lead time (hours between forecast crossing the critical threshold and the threshold engine firing), training cost (GPU-hours), inference p50/p99 per 256-window batch on CPU and GPU, parameter count. Significance: Diebold–Mariano per horizon, Holm correction across model pairs.

### Foundation time-series models (optional baseline)

Current second-generation families (verified 2026-09-28): **Chronos-2** (Amazon, Oct 2025; univariate, multivariate and covariate-aware, patch-based, quantile objective), **TimesFM 2.5** (Google; decoder-only, ~200M parameters, continuous quantiles), **Moirai 2.0** (Salesforce; decoder-only redesign with quantile loss). Use them as (a) a zero-shot baseline the hand-built model must be compared against, (b) a cold-start candidate for bins with too little history, (c) a sanity check on simulator realism. Do not put them on the per-event path: model size makes inline inference at 1.67M events/s cost-prohibitive (UNMEASURED; I4 measures per-window latency to prove or refute). Check each licence and whether weights may be self-hosted in EKS before use.

### I4 edge cases and failure modes

| # | Case | Handling | Test |
| --- | --- | --- | --- |
| 4.1 | All keys masked in a row | Return zeros and a `fully_masked` flag; no NaN | Unit |
| 4.2 | fp16/bf16 softmax overflow | Subtract row max; compute softmax in fp32 under autocast | Large-logit test |
| 4.3 | Context shorter than one patch (< 8 steps = 2 h) | `insufficient_history` | Unit |
| 4.4 | Variable sensor count per bin (reference bin = 16 devices, R5) | Channel independence handles any count; spatial-attention ablation uses padding mask | Bins with 1, 4, 16, 64 devices |
| 4.5 | Positional encoding beyond trained length | Refuse at serving (max context enforced by contract) | Contract test |
| 4.6 | Future leakage through normalisation (RevIN over context+target) | Stats from context only | Future-perturbation test |
| 4.7 | Attention collapse (uniform or one-hot everywhere) | Entropy per head logged; alert in training dashboards | Metric |
| 4.8 | Transformer underperforms GBM on small data | Reported as the result; not shipped | G4.3 |
| 4.9 | ONNX export of custom attention | Parity test; if exporter fuses to SDPA op, re-run parity | Export test |
| 4.10 | Explanation for a different tenant's prediction requested | Explanations stored in `greenguard_ml` keyed by tenant with forced RLS; request denied | T-I5-3 |

### I4 acceptance gates

| Gate | Sample | Metric | Threshold |
| --- | --- | --- | --- |
| G4.1 attention parity | 1,000 random shapes × 4 mask modes | max abs diff vs `F.scaled_dot_product_attention` | fp64 ≤ 1e-10, fp32 ≤ 1e-6 |
| G4.2 causality | 500 sequences | output change at ≤ t after perturbing > t | exactly 0 |
| G4.3 skill | same folds as G3.3 | mean pinball vs best of GBM/LSTM/TCN, DM test | reported; champion only if better with p < 0.05 after Holm |
| G4.4 calibration | same | 80% coverage | 0.75–0.85 |
| G4.5 explanation stability | 200 predictions | Spearman rank correlation of patch importance, occlusion vs rollout | reported (no pass threshold; a teaching metric) |
| G4.6 foundation baseline | same folds | pinball of Chronos-2 / TimesFM 2.5 zero-shot | recorded in the comparison table |

---

## I5 — Online ML serving and MLOps

Stage dependencies (README §5): I2, GG-06, GG-10b (flags). I5 builds the `ml-scoring` online path, the shadow table, cohort canary, the scored-through watermark, drift, retraining, the forecast read model, and the **minimum metrics + alert rules** needed for automatic rollback (or promotion stays manual until I12).

### Design decisions

**D5.1 Two scoring tiers (R9).**

| Tier | Models | Trigger | Output | Why |
| --- | --- | --- | --- | --- |
| A — inline, per device reading window | Lightweight fault-vs-hotspot classifier (MLP/GBM) + a cheap point-anomaly score, ONNX on CPU | Each poll of `greenguard.telemetry.recorded.v1`, scored as an **inline micro-batch** per partition (see Processing semantics) over each device's recent reading window | Every prediction is committed to `ml_predictions`; `ml.anomaly.state_changed` enters the outbox **only on material change** (the device's anomaly state flips, e.g. `normal → suspected_sensor_fault`) | Needs per-reading latency; small model; publishing only on material change keeps Kafka volume and write amplification bounded (review R3) |
| B — scheduled micro-batch, per bin | TCN/LSTM/transformer forecasts, autoencoder window score | **Every 15 minutes per bin** on the R5 grid, as a scheduled micro-batch once the scored-through watermark has passed the grid point plus allowed lateness (ADR-0006) | Every forecast is committed to `ml_predictions`; `ml.forecast.recorded` enters the outbox only on material change (status change, or q50 / `p_exceed_critical_24h` moved beyond a configured delta) | Forecasts are per bin, not per reading; batching 256 windows per call makes deep learning affordable |

Every cycle (both tiers), ml-scoring also publishes a **scored-through watermark** `ml.scored_through.v1` per input partition, keyed `cell:partition` (ADR-0009 checkpoint pattern). Plain meaning: "every reading on this partition up to this offset and this event time has been scored". Because not every prediction is published, **every read-side freshness check uses the watermark**, never "time since the last prediction event": advisor staleness, the prediction-freshness SLO, the missing-prediction guardrail and the dashboard's freshness badge.

Rejected: DL on every reading (at Tier U that is ~1.67M transformer calls/s, UNMEASURED but clearly orders of magnitude costlier than per-bin windows); publishing every prediction (doubles or triples event volume for no reader benefit); request-time scoring from the BFF (couples dashboard latency to model latency).

Rough load (UNMEASURED, to be proven in I13; I0 recomputes from R5): Tier 1 has 1M devices; at 16 devices per bin that is ~62,500 bins → 62,500 forecasts per 15 min ≈ 70 windows/s for tier B — trivially batched on CPU. Tier U is ~100× → ~7,000 windows/s. Tier A inherits the full reading rate: at R5 cadence 1M devices × 1 reading per 15 min ≈ 1,111 readings/s, far below the capacity model's current 20k/50k events/s Tier-1 figure. Until I0 reconciles the two, tier A is sized for the capacity-model figure; it is the real capacity risk.

**D5.2 A new service `services/ml-scoring` (Python), sole owner of database `greenguard_ml` (R1, R2).** Inputs are exactly the real topics in R3:

| Topic | What ml-scoring takes from it |
| --- | --- |
| `greenguard.telemetry.recorded.v1` | **All sensor values.** Feeds the online window state and tier A. |
| `greenguard.inventory.device.v1` | Device ↔ bin binding and mount position (cable, depth), for grouping the 16 devices of a bin. |
| `greenguard.inventory.lot.v1` | Lot facts used as features (grain type, days in storage). |
| `greenguard.inventory.facility.v1` | Site/bin metadata used as features and for grouping. |
| `greenguard.risk.assessment.v1` | Only the risk-engine's **lot join** (`lot_id`, `grain_type`, `occupancy_version` for a reading) and its **verdict** (score, severity) for comparison and guardrails. Never sensor values. |
| `greenguard.risk.assessment_invalidated.v1` | Retractions: invalidate and rescore predictions that used the retracted lot join. |

ml-scoring owns the **online window state** (formerly the separate `greenguard_features`, now part of `greenguard_ml`), computed by its own streaming consumer with the shared `packages/ml-features` kernel, so online and offline features come from one piece of code. There is no I1 online feature store and no other writer. Which crop was in a bin at a time stays the risk-engine's answer: ml-scoring uses the `lot_id`/`occupancy_version` from the matching `risk.assessment` and does not become a second authority for the lot join; a bin window whose readings have no matching assessment yet is scored with `status = lot_pending` and no advisory. Rejected: embedding ML into risk-engine (would put model loading and ML dependencies inside the deterministic safety path and couple their release cycles); consuming only risk events (they carry no sensor values).

**D5.3 ML augments; thresholds remain the safety floor (R7).** The threshold policy in `risk_engine/scoring.py` and the workflow-alerts default rule are never modified, suppressed or down-graded by any model. ML can only (a) add **advisory** signals (forecast "critical threshold likely within 24 h", suspected hotspot), and (b) show "likely sensor fault" next to a threshold alert in the dashboard, composed at read time from the forecast read model. An ML output can never close, suppress or de-escalate a threshold alert, and `workflow-alerts` does not consume `ml.prediction.v1` (R8). Rejected: ML replacing thresholds (unexplainable failures, no safety floor during drift); ML silently lowering severity on "probable sensor fault" (a real hotspot misclassified as a fault would hide a fire risk — the costliest error). Promotion of ML to alert authority needs a new ADR and is out of scope.

**D5.4 Shadow predictions are table-only (R8).** Shadow predictions are written **only** to `greenguard_ml.ml_shadow_predictions`. They are never written to the outbox, so no shadow row can reach CDC or Kafka. There is no shadow topic. Only champion and canary predictions are written to `ml_predictions` and, on material change, to the outbox. This is structural, not a flag:

- The shadow scorer's repository has no outbox writer; it can only insert into `ml_shadow_predictions`.
- `outbox_events` has a `CHECK` constraint rejecting `payload->>'mode' = 'shadow'`, so even a code mistake fails the transaction instead of publishing.
- The event contract's `mode` enum is `{canary, champion}`; a consumer that sees any other value ignores the event.

Plain meaning: a shadow model can be as wrong as it likes and no farmer, dashboard or notification ever sees it. Its rows are read only by the evaluation jobs that compare it with the champion.

**D5.5 Canary by tenant cohort, selected inside ml-scoring (R10).** ml-scoring evaluates the Stage 10 OpenFeature flag `ml.forecast_advisory` per tenant: stable hash buckets on `tenant_id` + an explicit opt-in allowlist + an explicit deny list (for example tenants under contractual "no ML" terms). The flag says which **cohort** a tenant is in; the deployment manifest says which model version serves each cohort. Steps 1% → 5% → 25% → 50% → 100% of eligible tenants, each held ≥ 72 h. Whether canary advisories may notify or are dashboard-only follows README §8 Q11 (default here: dashboard only).

**D5.6 Model deployment authority is Git (R10).** A per-cell deployment manifest in `infra/gitops` (Argo) is the only source of which model version is champion or canary per cohort. Argo renders it into ml-scoring's config. Serving watches that config, downloads the named **version** (never an alias) from MLflow, verifies the artifact SHA-256 against the model card, loads an ONNX Runtime session, runs warm-up on the golden inputs and **checks outputs against the recorded golden outputs** (tolerance 1e-4) before an atomic pointer swap. Every prediction records the concrete `model_version`. MLflow aliases are a **reconciled projection**: a reconciler (README §4 row, infra/gitops) sets them to match Git and reports drift. Nothing — not the pipeline, not the rollback controller, not a person — writes MLflow aliases directly. `ml.model_deployment.v1` and a `model_deployments` table do not exist. MLflow is never on the hot path: an MLflow outage leaves the current model serving and raises an alert.

**D5.7 Runtime: ONNX Runtime on CPU by default; GPU only where measured to pay.** Tier A: CPU `CPUExecutionProvider`, intra-op threads = 1 per worker, many workers. Tier B: CPU first; an EKS g6 (L4) GPU NodePool with the CUDA execution provider only if I13 shows cost per 1k windows is lower. Dynamic batching: collect up to 256 windows or 50 ms, whichever first. Rejected: Triton/KServe as the first step (adds an inference-server hop and its own rollout model before we have measured need; revisit alongside I6).

**D5.8 Pooled global models, not per-tenant models.** One model per task and grain family, with **no `tenant_id` feature**. Per-tenant models are rejected at 10M tenants (10M registry entries, most tenants too small to train, impossible to canary). Optional later: per-tenant **calibration** of interval widths via split-conformal residuals on that tenant's own recent errors, stored in the tenant's rows. Which tenants' data may train the pooled model is decided by consent (D5.14), not by this service.

**D5.9 Cold start.** New bin/site: pooled model with padding masks once ≥ 6 h (24 steps) of history exist; before that, `status = insufficient_history` and no advisory. New grain type with no training data: no ML advisory (same rule as `policy_unavailable` in risk-engine: never score a crop with another crop's model). Foundation model zero-shot is the evaluated fallback candidate (I4).

**D5.10 Retraining orchestration.** The orchestrator follows README §8 Q12 (**Argo Workflows on EKS recommended**: same cluster, Kubernetes-native, Pod Identity per step, no extra service; **SageMaker Pipelines** or **AWS Step Functions** are the alternatives, each moving step execution or orchestration outside the cluster). The earlier draft's Kubeflow-Pipelines-on-a-managed-ML-service choice is withdrawn pending that decision; the pipeline steps below are orchestrator-independent, and components are container images built by our CI.

Pipeline: `snapshot training data (I1 export, as_of, consent filter per D5.14) → validate data (schema, ranges, PSI vs previous snapshot, per-tenant cap) → train (I3/I4 trainer, GPU step) → evaluate on I2 folds + fresh holdout → compare to champion (gates) → export ONNX + parity → write model card → register the version in MLflow (no alias) → open a promotion pull request against the Git deployment manifest`. Merging that PR is a recorded human approval; automatic promotion is a later, separately gated capability. Triggers: weekly schedule; drift trigger (D5.12); manual. Idempotency: pipeline run key = `(model_name, feature_set_version, data_snapshot_digest, code_sha)`; a repeated trigger with the same key is a no-op.

**D5.11 Automatic rollback controller — only with minimum observability (README §5).** A small `model-release-controller` job (every 60 s) evaluates guardrail PromQL over the canary vs control cohorts and, on breach:

1. **Fast path (seconds):** sets the flag cohort to 0%, so every tenant is served by the champion again.
2. **Durable path:** automatically opens and merges a Git revert of the manifest change (subject to the repository's required checks); the reconciler then projects the reverted state to MLflow aliases.

The controller never writes MLflow aliases. Rollback never touches threshold alerts (they were never changed). If the revert cannot merge, the flag stays at 0% and the controller pages; the flag is the safety, Git is the record.

**Minimum observability shipped in I5** (the README §5 condition): the ml-scoring metrics named in the guardrail table below, the watermark lag per partition, and Prometheus alert rules for each guardrail, with tests that fire each rule from an injected fault. **If these are not shipped in I5, automatic rollback is disabled and every canary step is a manual promotion and manual rollback until I12 delivers them.**

Guardrails (canary vs matched control cohort, per 1,000 bin-days):

| Guardrail | Breach |
| --- | --- |
| ML advisory rate | > 2× control-expected rate or > absolute cap |
| Advisory dismissed-as-false rate (operator feedback) | > 40% over ≥ 200 advisories |
| Threshold alert that ML annotated "likely fault" but later confirmed real | any 1 → immediate rollback + incident |
| Missing prediction rate: bins with no committed prediction for a grid point the **scored-through watermark** has already passed (plus allowed lateness) | > 1% |
| Tier A p99 scoring latency | > 50 ms over 10 min |
| Consumer lag on ml-scoring input topics (R3) | > 5 min |
| Watermark stalled on any partition | no advance for > 5 min while input lag > 0 |
| Prediction distribution drift vs shadow baseline | PSI > 0.25 |

**D5.12 Drift and performance monitoring.**

- Feature drift: PSI (10 quantile bins fixed from the training snapshot) and two-sample KS per feature, per grain type and region, daily; **not per tenant** unless the tenant has ≥ 5,000 windows in the period (small samples produce noise). PSI 0.1–0.25 warn, > 0.25 act. Aggregates are published on `greenguard.ml.drift.v1` (key `model_name`, aggregate only, no per-tenant data).
- Prediction drift: PSI on the median forecast and on class probabilities.
- Label-delayed performance: forecasts are scored automatically when their horizon passes (pinball, coverage) — a rolling 7-day window per horizon; anomaly performance from a continuously running synthetic **canary tenant** (`tenant.synthetic`, excluded from billing, training and notifications per R32) and operator verdicts.
- Feature/serving skew: 1% of served feature vectors (and the digest of all) are logged in `greenguard_ml`; a nightly job recomputes the same features from the I1 offline export at the same `as_of` and compares. Any mismatch rate > 0.1% or max abs diff > 1e-6 blocks promotions and alerts. The R4 parity sample is the stronger, end-to-end version of this check.
- Drift action: open a retraining run; never auto-promote on drift alone.

**D5.13 Prediction storage, material-change publishing and write amplification (R9).** Every champion/canary prediction is committed to `ml_predictions` (RLS database) and every shadow prediction to `ml_shadow_predictions`, in **batched transactions per poll** (one transaction per tenant within the batch). The outbox receives only material changes plus nothing for shadow. Prediction logs are served to tenants only from the RLS database through read-api (R6); evaluation jobs may export pseudonymised Parquet, which is never served to tenants. Because every prediction is stored, the earlier draft's "lossy analytics log outside the outbox" exception is withdrawn. I5 **measures and records**: the publish ratio (outbox events ÷ predictions committed, per tier), rows and WAL bytes written to `greenguard_ml` per input reading, and index amplification — the numbers review R3 asks for.

**D5.14 Training data and feedback labels (R24).**

- Consent is read from the projected `greenguard.tenant.ai_consent.v1`: `none` (default) → never trains any model; `own_tenant` → only calibration for that tenant; `pooled` → may contribute to pooled models.
- **Until ≥ 50 tenants consent to `pooled`, pooled models train on simulator data only.**
- Pooled training uses **structured features and enums only** — no free text, no agent trajectories.
- Export runs **one RLS transaction per tenant** as the tenant (no BYPASSRLS, no SECURITY DEFINER), writing HMAC-pseudonymised Parquet (R6).
- **Feedback labels** (operator verdicts, advisory dismissals) are used for retraining **only for tenants with `pooled` consent**; they are **weighted per tenant** (each tenant's labels sum to at most its share) and **capped** so no tenant exceeds 10% of pooled rows or of feedback labels in a snapshot.
- Consent revocation removes the tenant from the next snapshot; models trained before revocation are flagged for retrain within the deletion/revocation SLA.
- **Adversarial-tenant test** (T-I5-8, G5.16): one tenant at the cap submits inverted or mass-dismissed labels; other tenants' evaluation metrics must not move beyond a stated tolerance.

### Data ownership and contracts

Database `greenguard_ml` (owner `ml_migrator`, runtime `ml_app` with `NOBYPASSRLS`, no DELETE; PgBouncer transaction mode; `set_config('app.tenant_id', …, true)` per transaction). CDC onboarding for this new source DB (Debezium connector, slot with WAL/slot-age alerts per review H3, audited CDC read exemption on the outbox only per R1/H2, schemas, transformer routing, aggregate-ID checks per H5) is part of I5 (README §3).

| Table | Tenant/RLS | Writes | Concurrency choice (ADR-0002) |
| --- | --- | --- | --- |
| `consumer_inbox` | forced | INSERT | PK + `ON CONFLICT DO NOTHING`, digest compare (same as risk-engine) |
| `device_window_state` (online window state, R2) | forced, composite `(tenant_id, device_id)` | upsert rolling window, `last_source_event_seq` | row lock via `ON CONFLICT DO UPDATE`; monotone sequence guard (stale readings are no-ops) |
| `device_anomaly_state` | forced, composite `(tenant_id, device_id)` | upsert state, last published state | same row-lock pattern; material-change comparison inside the lock |
| `bin_window_state` | forced | upsert grid point, last published forecast digest | `FOR UPDATE` on the bin row (hot single row per bin) |
| `ml_predictions` (champion/canary, tier A and B) | forced, composite FKs | INSERT only | unique `(tenant_id, subject_id, window_end, model_version, feature_set_version, revision)` |
| `ml_shadow_predictions` | forced | INSERT only; never read by the outbox writer | same unique key |
| `prediction_invalidations` | forced | INSERT only | one per prediction |
| `tenant_calibration` | forced | upsert | optimistic version column + 409 |
| `explanations` | forced | INSERT only | unique per prediction |
| `training_manifests` | forced (per-tenant inclusion rows) | INSERT only | unique `(snapshot_digest, tenant_id)` |
| `outbox_events` | forced; CDC snapshot policy for `cdc_reader` (review R1); `CHECK mode <> 'shadow'` | INSERT only | unique aggregate version |
| `scoring_checkpoints` (watermark source) | non-tenant (R27 allowlist: cell, topic, partition, offset, event time) | upsert per partition | `FOR UPDATE` per partition row; monotone guard |
| `quarantine_samples` | not tenant data (Kafka coords, reason, digest) | bounded overwrite | slot = offset % 1000 |

The model registry and prediction-log exports are not tenant tables; they contain only HMAC pseudonyms, never raw tenant IDs (T-I5-5).

Deterministic IDs: `prediction_id = uuid5(NS_ML, f"{tenant}:{subject_id}:{window_end}:{model_name}:{model_version}:{feature_set_version}:{revision}")` (revision starts at 0 and increments only on late-data or invalidation recompute); anomaly transition `event_id = uuid5(NS_ML, f"{tenant}:{device_id}:{source_event_id}:{model_version}")` where `source_event_id` is the telemetry reading's event ID. Replays and retries never mint new IDs.

New event contracts (JSON Schema in `contracts/events/`, same v1 envelope as `risk.assessed`: `event_id, event_type, schema_version, occurred_at, tenant_id, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, traceparent, payload`):

| Event / topic | Key | Payload (v1) |
| --- | --- | --- |
| `ml.anomaly.state_changed` on `greenguard.ml.prediction.v1` (material change only) | `tenant_id:device_id` (registry) | `prediction_id, device_id, bin_id, from_state, to_state (normal / suspected_sensor_fault / suspected_hotspot), probabilities{…}, source_event_id, model{name, version, onnx_sha256}, mode (canary / champion)` |
| `ml.forecast.recorded` on `greenguard.ml.prediction.v1` (material change only) | see open question Q6 (registry key is `tenant_id:device_id`; a bin forecast has no device) | `prediction_id, bin_id, lot_id, grain_type, occupancy_version, window_start, window_end, horizons[{hours, targets{temperature_c{q10,q50,q90}, relative_humidity_percent{…}}}], p_exceed_critical_24h, status (ok / insufficient_history / lot_pending / grain_unsupported / model_error), model{…}, feature_set_version, feature_digest, mode (canary / champion), source_assessment_ids_digest` |
| `ml.prediction.invalidated` on `greenguard.ml.prediction.v1` | same as target | `prediction_id, reason (assessment_invalidated / late_data / model_recalled), replacement_prediction_id?` |
| `ml.scored_through` on `greenguard.ml.scored_through.v1` (every cycle) | `cell:partition` | `cell, source_topic, partition, scored_through_offset, scored_through_event_time, cycle_id, tier, model_versions[]` — no tenant data |

There is no shadow topic and no `mode = shadow` value (D5.4). Versioning: additive fields are minor and allowed; any change to the meaning of a field or quantile set is a new `schema_version` and a new topic suffix `.v2`, dual-published during migration (ADR-0003/ADR-0010 rules). Consumers ignore events with an unknown `mode`.

### Changes to existing services (README §4 rows owned by I5)

| Change | Service | Exit test |
| --- | --- | --- |
| **Forecast read model**: consume `ml.prediction.v1` and `ml.scored_through.v1`; store the latest forecast and anomaly state per bin/device plus the watermark per partition | projection-builder | two-tenant test + freshness-watermark test |
| **Read-api endpoint** for predictions, returning each result with its freshness derived from the watermark (`fresh` / `stale` / `lot_pending` / `insufficient_history`) | read-api | two-tenant test + freshness-watermark test |
| **BFF predictions GraphQL** (forecast, anomaly state, "likely sensor fault" annotation next to threshold alerts, freshness) | bff | two-tenant test + freshness-watermark test |
| **Alert verdict on acknowledge** (`confirmed_real / sensor_fault / false_alarm`), only if README §8 Q10 = yes; used as anomaly labels under D5.14 | workflow-alerts | verdict persisted, tenant-scoped |
| **Per-cell deployment manifest + reconciler** (Git → MLflow aliases) | infra/gitops | alias drift reconciled to Git |

The freshness-watermark test: stop ml-scoring mid-stream; the read path must report `stale` once the watermark falls behind by more than the SLO window, even though the last forecast row is still present; restart; it must return to `fresh` without a new prediction event if nothing materially changed.

### Processing semantics (idempotency, ordering, throughput)

- **Batched transactions per poll (R9).** ml-scoring processes micro-batches per partition (up to 500 records or 20 ms), preserving per-key order. Within a batch: one transaction per tenant containing inbox receipts, state changes, `ml_predictions`/`ml_shadow_predictions` rows and any material-change outbox rows; then one transaction advancing `scoring_checkpoints` and writing the `ml.scored_through` event; then the Kafka offsets commit. Offsets commit only after the batch's effects (or a confirmed quarantine), at the lowest fully-committed contiguous position (the platform's contiguous commit frontier). A crash anywhere re-runs the batch; inbox dedupe and deterministic IDs make that a no-op, and the watermark is monotone.
- **Capacity conflict:** the canonical and risk topics have six partitions; a per-record transaction (the risk-engine pattern) will not reach 3,333–8,333 events/s per consumer (UNMEASURED). Batching is the answer here, and it needs its own reviewed ADR; it also shares the partition-count problem with every other consumer (Q5).
- **Invalidation:** on `risk.assessment_invalidated`, ml-scoring writes `prediction_invalidations`, emits `ml.prediction.invalidated` for predictions whose inputs used that assessment's lot join, and rescores the corrected window with `revision + 1`.
- **Not ready:** device binding or lot join not yet known for a reading → the reading enters window state; the affected bin prediction is committed with `status = lot_pending` and no advisory; after a bounded wait the reason is counted. A missing inventory projection pauses the partition with backoff (like `lot_state_unavailable`), then quarantines.

### Latency budgets (targets, UNMEASURED)

| Path | Budget |
| --- | --- |
| Tier A: `telemetry.recorded` consumed → prediction committed | p99 ≤ 250 ms (ONNX inference itself p99 ≤ 5 ms per batch of 64 on CPU) |
| Tier B: grid point passed by watermark → forecast committed | p99 ≤ 60 s |
| Watermark: batch committed → `ml.scored_through` visible in the read model | p99 ≤ 30 s |
| Model reload: manifest merge → 100% of pods serving new version | ≤ 5 min (Argo sync) + ≤ 90 s (pod reload) |
| Rollback fast path: guardrail breach → canary cohort at 0% | ≤ 120 s |
| Rollback durable path: breach → Git revert PR opened | ≤ 5 min |

### EKS deployment

- `ml-scoring-inline` (tier A) Deployment (CPU, HPA on consumer lag via Prometheus adapter; replicas ≤ partition count unless intra-partition concurrency is proven), `ml-scoring-window` (tier B) Deployment (CPU, optional GPU NodePool with taints/tolerations; Spot with On-Demand fallback), `model-release-controller` CronJob, pipeline components as images signed with Cosign (Stage 12). EKS work follows ADR-0024 (accepted, R29) and is certified in I13; I5 first runs in the local/Compose profile.
- EKS Pod Identity for S3 (SSE-KMS) and MLflow access; model artifacts read-only; NetworkPolicy denies egress except Kafka, PgBouncer, MLflow, S3, the flag provider, OTel collector.
- PodDisruptionBudgets; graceful shutdown drains the in-flight batch and commits before exit (CodeRabbit assertive check on `services/**`).
- OTel through `packages/otel-py` (R28): continue the `traceparent` from `telemetry.recorded` into ML outbox rows; spans `ml.feature_update`, `ml.infer`, `ml.commit` with attributes `model.name`, `model.version` (never tenant on metric labels or span attributes).

### Model cards

Generated by the pipeline, stored as an MLflow artifact and rendered in docs: intended use ("advisory only; never suppresses threshold alerts"), training data (synthetic vs real, date range, consent class and tenant-count bucket, feature-set version, snapshot digest), metrics per fold/horizon/grain type/tenant-size decile, calibration, known failure modes (from the edge-case tables), fairness-equivalent slices (region, sensor vendor, bin size), export parity result, reproducibility info, approvers (the merged manifest PR).

### I5 edge cases and failure modes

| # | Case | Expected handling | Test |
| --- | --- | --- | --- |
| 5.1 | Duplicate `telemetry.recorded` or `risk.assessment` delivery | Inbox dedupe; same prediction ID; no second row or outbox event | Replay test |
| 5.2 | Reordered readings for a device | `last_source_event_seq` guard; stale reading is a no-op receipt | Reorder test |
| 5.3 | Same event ID, different payload | Quarantine `event_id_conflict` | Unit |
| 5.4 | Assessment invalidated after prediction | `prediction_invalidations` row + `ml.prediction.invalidated`; rescore corrected window with `revision + 1` | E2E |
| 5.5 | Late reading after the grid point was scored | Within allowed lateness: recompute, invalidate the old prediction, commit a replacement with `revision + 1` (ID still deterministic on replay); publish only if materially different; beyond max lateness: counted, not rescored | Lateness test |
| 5.6 | Inventory/lot projection not ready | Pause with backoff, then `lot_pending` status; threshold path unaffected | Fault injection |
| 5.7 | MLflow unavailable | Keep serving current model; alert; no reload | Fault injection |
| 5.8 | Corrupt or tampered artifact | SHA-256 mismatch → refuse load, keep old model, alert | Unit |
| 5.9 | New model fails golden-output check | Refuse swap; pods report the manifest version as not converged; alert | Unit |
| 5.10 | Half the pods on old version during reload | Each prediction carries `model_version`; evaluation groups by version; canary metrics exclude mixed windows | Test |
| 5.11 | Manifest names a model with a different input schema | Signature check (input names/shapes/feature_set_version) before load; refuse; CI check on the manifest PR catches it first | Unit + CI |
| 5.12 | ONNX Runtime OOM / thread oversubscription | Bounded batch size, fixed intra-op threads, memory limit; pod restart resumes from committed offset | Load test |
| 5.13 | GPU node reclaimed (EC2 Spot interruption, 2-minute notice) | Tier B falls back to CPU pool; latency SLO may breach, correctness does not | Chaos test |
| 5.14 | Model outputs NaN | Output validated; `status=model_error`, counted, no advisory; repeated → rollback | Unit |
| 5.15 | Model says "likely sensor fault" on a real hotspot | Threshold alert still fires (safety floor); annotation guardrail triggers immediate rollback | Canary guardrail test |
| 5.16 | Shadow model misconfigured to publish | Impossible by structure: the shadow scorer has no outbox writer, and the outbox `CHECK` rejects `mode = shadow`, so the transaction fails and the error is alerted; no shadow row reaches Kafka | Unit test inserting a shadow row into the outbox expects a constraint error; G5.1 |
| 5.17 | Flag service down | OpenFeature default = control cohort (champion only, no canary) | Flag outage test |
| 5.18 | Tenant moves cells (Stage 12–14) | Window/anomaly state keyed by tenant; migrated with the tenant's cell data or rebuilt by replay | Replay test |
| 5.19 | Replay from retained Kafka | Deterministic IDs → identical predictions for the same model version; different version → new IDs, old ones not invalidated automatically (replay to a new version is an explicit backfill) | Replay equality test |
| 5.20 | Drift from a holiday/heat wave (true shift, model still right) | Drift triggers retraining candidate only; performance metrics decide promotion | Process |
| 5.21 | Label feedback poisoning (one tenant mass-dismisses or inverts verdicts) | Feedback used only with `pooled` consent; weighted per tenant and capped at 10% of labels (R24); other tenants' metrics must stay within tolerance | Adversarial-tenant test T-I5-8 |
| 5.22 | Retraining job partial failure | Step retry; run key idempotency; no promotion PR unless all gates pass | Pipeline test |
| 5.23 | Two retrains race to promote | Both open PRs against the same manifest; the manifest records the expected current version and a CI check rejects a PR whose base no longer matches (optimistic); the loser must rebase and re-run gates | CI test |
| 5.24 | Training data contains a deleted tenant (O2) or revoked consent | Snapshot excludes tenants with deletion tombstones or without consent as of snapshot time; models trained before flagged for retrain within the deletion SLA | Deletion/consent test |
| 5.25 | Consumer lag grows beyond retention | `RISK_KAFKA_OFFSET_RESET=error`-style: stop, never skip; alert | Test |
| 5.26 | Hot tenant floods scoring | Per-tenant token bucket on tier A; excess readings still get threshold scoring and a `rate_limited` ML status; the watermark still advances | Load test |
| 5.27 | Clock skew between devices in a bin | Watermark uses event time with allowed lateness; a silent device is excluded after a staleness timeout so grid points still score | Unit |
| 5.28 | Nothing changes for hours (no material change, no events) | Watermark keeps advancing every cycle, so readers show `fresh`; no false "missing prediction" | Freshness-watermark test |
| 5.29 | One partition's watermark stalls | Only bins on that partition show `stale`; guardrail fires; others unaffected | Fault injection |
| 5.30 | Someone edits an MLflow alias by hand | Reconciler resets it to the Git manifest and reports drift; serving never read the alias | Reconciler test |
| 5.31 | Automatic Git revert cannot merge (CI down) | Flag cohort stays at 0% (safe); controller pages; manual revert | Fault injection |
| 5.32 | I5 metrics or alert rules missing at release | Automatic rollback disabled; promotion is manual until I12 | Release checklist test |

### Tenant-isolation tests (all three stages)

| ID | Test |
| --- | --- |
| T-I3-1 | The training export runs one RLS transaction per tenant as that tenant (no BYPASSRLS/SECURITY DEFINER, R24); with `app.tenant_id` = A it returns zero rows of tenant B, and tenants without the required consent return zero rows |
| T-I3-2 | No model input tensor contains `tenant_id`, a tenant pseudonym or any tenant-identifying column (static check on the feature list + runtime assertion) |
| T-I4-1 | **Batch invariance:** prediction for tenant A's window is bit-identical whether batched alone or with 255 windows from tenant B (no batch norm in eval, no cross-row attention); run for every served model |
| T-I5-1 | ml-scoring runtime role reading `ml_predictions`/`ml_shadow_predictions`/`device_window_state`/`device_anomaly_state` with tenant A context sees no tenant B rows; writing with mismatched `tenant_id` fails RLS (`42501` stops the process, never quarantined) |
| T-I5-2 | For every consumed topic, Kafka key, envelope `tenant_id` and payload tenant must match; mismatch is quarantined (`tenant_mismatch`) (R27) |
| T-I5-3 | Prediction, explanation and forecast reads through read-api/BFF/agent tools for tenant A cannot return tenant B objects; they are served from the RLS database, never from Parquet |
| T-I5-4 | Canary flag evaluation for tenant A never affects tenant B's advisories (cohort toggle test with two tenants in different buckets) |
| T-I5-5 | Prediction-log exports, training manifests exported to S3 and model cards contain no raw tenant IDs (HMAC pseudonyms only) — grep test on artifacts |
| T-I5-6 | Per-tenant calibration of tenant A is never applied to tenant B (composite key + test) |
| T-I5-7 | Cross-tenant memorisation probe: train with a synthetic "canary" pattern injected only into tenant A; tenant B's forecasts show no statistically detectable response (membership-style check; teaching gate) |
| T-I5-8 | **Adversarial tenant at cap (R24):** one tenant at the 10% cap submits inverted verdicts and mass dismissals; every other tenant's evaluation metrics move less than the stated tolerance; a tenant without `pooled` consent contributes zero feedback rows |
| T-I5-9 | **Shadow never published:** after a shadow soak, `outbox_events` and every ML topic contain zero shadow predictions |
| T-I5-10 | Forecast read model, read-api and BFF: two-tenant isolation plus the freshness-watermark test (README §4) |
| T-I5-11 | Catalog check: every `greenguard_ml` table has `tenant_id` + FORCE RLS unless on the reviewed non-tenant allowlist (`scoring_checkpoints`, `quarantine_samples`) (R27) |

### I5 acceptance gates

| Gate | Sample | Metric | Threshold |
| --- | --- | --- | --- |
| G5.1 shadow non-interference | Replay of ≥ 30 days synthetic traffic (≥ 1M readings, ≥ 2 tenants) with shadow on vs off | Diff of `alert_episodes` + `alert_transitions` + notifications + read-model contents; count of shadow rows in outbox/Kafka | Byte-identical; 0 |
| G5.2 shadow soak | ≥ 14 days, ≥ 1M tier A predictions, ≥ 50k forecasts in `ml_shadow_predictions` | prediction coverage (non-error share) | ≥ 99% |
| G5.3 idempotency | 10k events delivered twice, 1k reordered | duplicate prediction/outbox rows / wrong-order state changes | 0 / 0 |
| G5.4 tier A latency | 10 min at Tier 1 per-partition target load (3,333 events/s per consumer, UNMEASURED target, recomputed by I0) | p99 consume→commit | ≤ 250 ms; lag stable |
| G5.5 tier B latency | 1,000 grid points | p99 watermark-passed→commit | ≤ 60 s |
| G5.6 model reload | 20 manifest changes under load | time to 100% pods on new version; dropped/duplicated predictions | within budget; 0 |
| G5.7 automatic rollback | 10 injected guardrail breaches (bad model that doubles advisory rate; model that labels real hotspots as faults) | breach → cohort 0%; Git revert PR opened; MLflow alias writes by the controller | ≤ 120 s and ≤ 5 min, 10/10; 0 |
| G5.8 drift detection | Injected shifts (sensor offset +3 °C on 20% of devices; humidity scale change) | detection delay; false alarms on 30 unshifted days | ≤ 1 daily cycle; ≤ 1 false alarm |
| G5.9 skew | 100k logged serving vectors | offline/online mismatch rate | ≤ 0.1% |
| G5.10 pipeline reproducibility | Re-run a registered model's pipeline from its run key | metrics within ±1% (GPU) / identical (CPU) | pass |
| G5.11 canary safety | Each canary step ≥ 72 h, ≥ 1,000 bin-days in cohort | guardrails in table D5.11 | no breach before widening |
| G5.12 cost | Tier 1 load | $/1M tier A predictions and $/1k forecasts, CPU vs GPU | recorded (UNMEASURED until run); GPU adopted only if cheaper at equal SLO |
| G5.13 publish ratio and write amplification (R9, review R3) | ≥ 7 days synthetic traffic at R5 cadence | outbox events ÷ predictions per tier; rows, WAL bytes and index bytes in `greenguard_ml` per input reading | recorded in evidence and `capacity_assumptions.json`; alert if publish ratio > 10% for tier A |
| G5.14 watermark freshness | ml-scoring stopped/started, one partition stalled, 6 h with no material change | read path freshness status | `stale` within the SLO window when stopped; `fresh` with no events when idle; only the stalled partition's bins `stale` |
| G5.15 minimum observability (README §5) | each guardrail fault injected once | alert rule fires; controller acts | 100%; otherwise automatic rollback disabled and promotion manual until I12 |
| G5.16 adversarial tenant (R24) | T-I5-8 scenario | other tenants' metric change | within stated tolerance; zero rows from non-pooled tenants |
| G5.17 forecast read path (README §4) | two tenants, full path ml-scoring → projection-builder → read-api → BFF | cross-tenant results; freshness from watermark | 0; correct |
| G5.18 parity sample (R4) | ~20 bin-seasons through telemetry-ingest → CDC → ml-scoring | online features vs simulator Parquet features | identical |

---

## Senior topics covered

Autograd internals and gradient checking; training-loop correctness and classic bugs; windowed time-series datasets without leakage; recurrent vs convolutional vs attention sequence models; probabilistic (quantile) forecasting and calibration; imbalanced-class losses (weighted, focal); unsupervised anomaly detection and physical-domain disambiguation (fault vs hotspot); mixed precision; determinism and reproducibility; hyperparameter search with pruning; experiment tracking and lineage; ONNX export, parity and quantisation; hand-written attention verified against the reference kernel; causal masking proofs; attention-based vs perturbation-based explainability; statistical model comparison (Diebold–Mariano, Holm); foundation time-series models as baselines; two-tier online scoring (inline vs scheduled micro-batch); event-time grids and watermarks; idempotent streaming inference with outbox, material-change publishing and write-amplification measurement; GitOps model deployment with verified hot reload; shadow/canary/rollback with alert-level guardrails; ML-as-advisory over a deterministic safety floor; drift (PSI/KS), prediction drift, label-delayed evaluation, feature/serving skew; retraining orchestration on EKS; consent-gated pooled training and poisoning-resistant feedback; cold start; model cards; tenant isolation in batched inference and training data.

## ADRs to write (numbered from 0023 upward per R30 when written)

1. **ML scoring tiers and the `ml-scoring` service boundary** (R3 inputs, owns `greenguard_ml` incl. online window state).
2. **ML advisory never overrides thresholds** (R7 safety-floor invariant; workflow-alerts does not consume ML predictions).
3. **ML prediction event contracts, material-change publishing and the `ml.scored_through.v1` watermark** (R8, R9; no shadow topic; bin-forecast key per Q6).
4. **Git deployment manifest as model deployment authority; MLflow aliases as reconciled projection; artifact verification** (R10).
5. **Cohort canary via Stage-10 flags and the automatic rollback controller**, including the I5 minimum-observability condition.
6. **Batched per-poll consumer transactions for high-rate inference** (contiguous commit frontier; checkpoint transaction; partition count).
7. **Retraining orchestration** (follows README §8 Q12).
8. **Consent-gated training data and feedback labels** (R24; deletion/revocation propagation; needs owner/legal input).
9. **Transformer architecture choice (patching + channel independence)** and foundation-model baseline policy.
10. **Determinism and reproducibility policy for training** (what "reproducible" means on CPU vs GPU).

## Claude skills to load when implementing

`ecc-pytorch-patterns`, `ecc-mle-workflow`, `wshobson-ml-pipeline-workflow`, `wshobson-quantized-export`, `wshobson-python-performance-optimization`, `wshobson-backtesting-frameworks`, `wshobson-evaluation-methodology`, `ecc-canary-watch`, `wshobson-prometheus-configuration`, `wshobson-slo-implementation`, `wshobson-gitops-workflow`, `ecc-kubernetes-patterns`, `wshobson-python-testing-patterns`, `wshobson-architecture-decision-records`, `wshobson-gdpr-data-handling` (training-data deletion), `context7--find-docs` (verify PyTorch ONNX exporter default, MPS autocast, MLflow alias APIs, OpenFeature Python SDK at the pinned versions).

## Open questions for the owner

Former Q1 (cross-tenant training) is decided by R24; former Q2 (alert verdict), Q3 (canary notifications) and Q4 (pipeline orchestrator) are README §8 Q10, Q11 and Q12.

- Q5: Raise `risk.assessment` / canonical partition counts now, or keep tier A behind the same Stage 13 partition redesign?
- Q6: The name registry gives `greenguard.ml.prediction.v1` the key `tenant_id:device_id`, but bin forecasts have no device. Amend the registry to allow `tenant_id:bin_id` for `ml.forecast.recorded`, or add a separate bin-keyed topic?
- Q7: What delta counts as a "material change" for a forecast (q50 °C change, `p_exceed_critical_24h` change)? Proposal: 0.5 °C or 0.1 probability, tuned from G5.13.

Sources consulted for foundation-model status: [Chronos-2](https://arxiv.org/html/2510.15821v1), [Moirai 2.0](https://arxiv.org/pdf/2511.11698), [2026 time-series toolkit overview](https://machinelearningmastery.com/the-2026-time-series-toolkit-5-foundation-models-for-autonomous-forecasting/).
