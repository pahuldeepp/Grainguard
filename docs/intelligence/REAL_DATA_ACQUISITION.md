# Real grain data acquisition

Status: best matched measured-data lead identified; no raw files acquired. External research data may be evaluated only for the task and terms granted by its authors. No result from this data would establish commercial-bin performance.

## Sources reviewed

1. **Rice mildew sensor study (best matched lead):** five measured, controlled experiments report 57,460 one-minute rows with timestamp, external/internal temperature and humidity, grain moisture and temperature, CO2, O2, and manually assessed mildew grade. Each experiment follows an induced mildew process in a 2.5 kg rice sample; raw data are available from the authors upon request. This is the closest task match found and could support an external, experiment-held-out evaluation of lab-scale mildew-grade prediction after data access and reuse terms are confirmed. It is not field telemetry, does not establish naturally occurring spoilage prevalence, and cannot validate GreenGuard's commercial-bin alert performance. Do not randomly split adjacent rows; hold out whole experiments (and preserve the published sequence boundaries). [Article and data statement](https://pmc.ncbi.nlm.nih.gov/articles/PMC11511114/).
2. **Larger Chinese flat-granary temperature/mildew study:** a paper reports temperature histories from 437 granaries (2017–2018) and additional data from 82 granaries (2023–2024), with storage-state classes including sampled/verified mildew and condensation. Although one historical dataset is described as previously published, the current paper's formal data statement says its presented data are available on request due to corporate confidentiality. The exact public repository, if any, and its license remain unverified. The newly collected histories and event samples are not openly available from the article. This is the strongest potential field/bin source if the authors confirm access to the older dataset or release the newer data, with event dates, granary IDs, label provenance, and use rights. The reported classes are imbalanced and not automatically equivalent to a forward-looking spoilage label. [Article and data statement](https://pmc.ncbi.nlm.nih.gov/articles/PMC11941915/).
3. **Stored-maize mycotoxin outcomes (Zenodo):** laboratory measurements from 129 farmer stores in South/Southwest Ethiopia, but no matched continuous bin telemetry or forecast-as-of history. The record's license field is blank, so confirm rights before reuse. It cannot supervise a sensor model or be joined to unrelated telemetry. It may be a separate descriptive/outcome-only source if terms are clarified. [Dataset record](https://zenodo.org/records/17141876).
4. **USDA stored-wheat insect-control study (downloadable, CC BY 4.0):** the Ag Data Commons release contains two years of grain-bin logger records and sampled wheat quality/insect results. I inspected the released files: mold rating is `1` for all 136 observations in 2022 and `1` for 141 of 142 observations in 2023, so the measured mold outcome has essentially no usable variation. The logger series are indexed by bin/quadrant, while the quality samples are silo-level; an exact silo-to-logger mapping is not established in the release. It is a real-data ingestion / schema exercise or a possible insect/quality study with careful target review, not a defensible mold/spoilage classifier. The release's intended use is insecticide-netting plus fumigation in bulk storage, so confirm that a secondary mold-focused analysis is within its stated use limitations. [Dataset and CC BY 4.0 metadata](https://figshare.com/articles/dataset/Data_from_Leveraging_insecticide-treated_netting_to_improve_fumigation_efficacy_for_the_protection_of_bulk_storage_of_commodities/25328671).
5. **Open stored-wheat insect infestation dataset (Mendeley Data):** CC BY 4.0 data for three wheat silos, five insect species, three sampling categories and 15 sampling occasions, with temperature/moisture and insect observations. This is a legitimate, usable lead for a separate insect-infestation task, not fungal spoilage or mycotoxin prediction. Do not relabel infestation as spoilage. [Dataset](https://data.mendeley.com/datasets/53ckhtd8gj/1).
6. **Pilot-silo CO2/T/RH and mycotoxin study:** two pilot wheat silos monitored for nine months, followed by mycotoxin analysis of two aggregate samples (affected hotspot and comparison area) after an induced wet pocket. Supporting data are available from the corresponding author on reasonable request. Two post-event aggregate outcome samples do not provide an independent, multi-site supervised evaluation set; repeated sensor readings do not create more independent outcome labels. [Article and data statement](https://pmc.ncbi.nlm.nih.gov/articles/PMC12595400/).
7. **Corn transport quality study:** real CO2/T/RH sensor measurements with dry-matter/physical-quality analysis are described, but the experiment targets transport and short-horizon quality loss, not in-bin spoilage forecasting; the analyzed datasets are available from authors on request. It is an adjacent transport-quality task, not a substitute label set. [Article](https://pmc.ncbi.nlm.nih.gov/articles/PMC10082028/).
8. **La Vega Innova / MAPA sensor feed:** its Spanish metadata describes internal/external temperature, internal humidity and fill level in silos and feeders associated with livestock farms in Pontevedra, at irregular cadence. It has no spoilage labels, and the description does not establish that the stored material is grain. A reuse license is not visible on the record. Do not treat it as GreenGuard grain telemetry without confirming commodity, access and rights. [Dataset record](https://opendata.lavegainnova.es/dataset/monitorizacion-de-silos-silos).

### Acquisition decision

There is no openly downloadable dataset found that is simultaneously (a) measured grain-bin sensor history, (b) matched to varied, adjudicated spoilage/mildew outcomes at an explicit entity/time boundary, and (c) clearly reusable for this evaluation. The rice study is the best next acquisition: request its raw rows and label protocol, then run a separate, explicitly lab-domain, whole-experiment holdout evaluation. In parallel, ask the flat-granary authors for the identified historical dataset's repository and license plus the event-level raw data. Keep the production spoilage claim blocked until a field dataset with representative independent events and outcome verification is available.

## Acquisition requests to the study authors

Request the de-identified, time-stamped CO2, temperature and RH series for both pilot silos and sensor nodes; the exact measurement units, calibration and missing/error codes; the silo/cable/node map; grain moisture and water-addition times; the lab sample locations/times and measured mycotoxin concentrations including LOD/LOQ; the data dictionary; and written permission/license for model development and publication. Ask whether the full series is available, rather than digitizing plotted figures. Do not treat the induced wet-pocket experiment as representative natural spoilage prevalence.

Separately ask the authors of the larger flat-granary study whether raw temperature/moisture histories and independently verified mildew/condensation sample records can be released for research, what the train/test entity boundaries and event dates are, and what reuse terms apply. Ask which of the 437-granary historical data are actually openly accessible and identify the exact record. Do not infer access from the article's phrase “publicly available” where its formal data statement says confidential data are available on request.

For the rice mildew study, request the five original unaggregated sensor CSVs with experiment IDs and exact start/end times; per-row mildew-grade annotations and the image/observer rubric used to assign them; the raw images or a documented image-derived label protocol; sensor units, calibration, missing/error codes and sampling gaps; exact water-addition/intervention times; grain variety and sample setup; and written permission/license for model development, publication, and any redistribution. Request confirmation that experiments are independent replicates and whether labels were assigned blind to sensor values. Evaluate by holding out entire experiments, with the reported model scores treated as paper-reported results rather than GreenGuard validation. Do not reconstruct rows by digitizing graphs.

## Model-use boundary

The rice mildew study is a strong candidate for a narrow external laboratory evaluation but its raw files require an author request and it cannot validate real-world storage performance. The Ag Data Commons release is openly downloadable and CC BY 4.0, but its inspected mold labels are nearly constant and the sample-to-logger mapping is unresolved. The Mendeley dataset supports insect infestation only. The Zenodo outcomes have no matched telemetry and no explicit license; the pilot silo study has two aggregate post-event outcome samples; and the promising multi-granary mildew study is access-restricted. Therefore no acquired dataset supports GreenGuard's production spoilage validation. The honest route is to request the rice raw series for a limited research benchmark and continue seeking field event data with explicit rights, representative positive/negative outcomes, and stable bin/sample IDs.

### Ready-to-send request

**To:** shijiankai@alu.hdu.edu.cn; hlfeng@zafu.edu.cn  
**Subject:** Request for rice mildew sensor time series and labels (Sensors 2024, 24, 6556)

Dear Dr. Shi and Dr. Feng,

I am preparing an external research evaluation of grain-mildew forecasting and read your paper, “A Monitoring Device and Grade Prediction System for Grain Mildew” (doi:10.3390/s24206556). The paper describes five rice mildew experiments with one-minute sensor records and manually assessed mildew grades, and notes that the supporting raw data are available from the authors upon request.

Would you be able to share the original time-stamped records for all five experiments, including experiment IDs, all sensor channels and units, mildew-grade annotations, and any missing/error codes? If available, please also share the grade-assignment rubric or images, sensor calibration details, and the timing of interventions such as water additions. I would use the data only under the terms you approve, preserve the experiment boundaries for evaluation, cite the paper and dataset, and not redistribute the files unless permitted.

Please let me know the appropriate data-use conditions or agreement. If the full raw data cannot be shared, a subset or the recommended application route would still be helpful.

Thank you,
GreenGuard research team

No request has been sent. External contact requires the user's explicit authorization.

**To:** e.garcia-cela@herts.ac.uk  
**Subject:** Data request: stored-wheat silo CO2/T/RH series and mycotoxin samples

Dear Dr. Garcia-Cela,

I am building a research prototype for forecasting grain-storage deterioration. Your paper, “Real-time CO2 monitoring for early detection of grain spoilage and mycotoxin contamination” (doi:10.1002/jsfa.70151), describes the matched nine-month pilot-silo sensor and mycotoxin study.

Would you be able to share the de-identified time-stamped CO2, temperature and relative-humidity measurements and the corresponding sensor-node/silo map, water-addition timing, grain-moisture records, and lab mycotoxin sample results with sample locations/times, units and detection limits? I would also appreciate the data dictionary and any conditions on research use, redistribution, or publication. I will not redistribute the data and can document attribution and permitted use.

If the complete records are unavailable, please let me know what subset is available and whether there is a preferred data-use agreement or application process.

Thank you,
GreenGuard research team
