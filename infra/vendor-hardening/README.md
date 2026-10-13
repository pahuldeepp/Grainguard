# Local vendor hardening review candidates

Status: **PARTIAL; neither candidate passes the release vulnerability policy.**
These artifacts do not modify the release inventory, image provenance status,
CI, Helm defaults, Terraform, or a running shared stack.

Kafka keeps Apache 3.9.2's complete Java distribution and upstream entrypoint.
Twenty-two signed Alpine 3.23 updates are locked in `kafka-apk-lock.json` by exact
version, URL, architecture and SHA256. The fetcher verifies checksums; the offline
build uses Alpine's existing trusted APK signing keys without `--allow-untrusted`.
Cassandra keeps the 5.0.9 Java distribution, cqlsh and entrypoint. The unchanged
gosu 1.19 source is rebuilt with checksum-locked Go 1.27.2 and its original module
versions. Module archives are locked by SHA256 and verified offline against
upstream go.sum. A deterministic vendor archive is locked before the image build.
The final runtime retains gosu privilege dropping and contains no compiler. Both
candidate image configurations explicitly default to the platform's non-root UID.
No JAR replacement or runtime removal is used.

From the repository root:

```sh
infra/vendor-hardening/build-and-scan.sh .local/vendor-hardening/review-UNIQUE gg-UNIQUE
python3 infra/vendor-hardening/test-tooling.py
python3 infra/vendor-hardening/smoke.py .local/vendor-hardening/smoke-UNIQUE gg-UNIQUE \
  --kafka-image gg-vendor-hardening-gg-UNIQUE/kafka:candidate \
  --cassandra-image gg-vendor-hardening-gg-UNIQUE/cassandra:candidate
```

Use a fresh lowercase identifier of 8–61 characters and a fresh output directory.
Build-and-scan returns **1** for any fixable HIGH/CRITICAL finding and **2** for
build/scanner failures or missing evidence. Internally Trivy findings use a distinct
exit code 17 so operational failures cannot leave a trusted clean-looking report. Scan cache/build context are unique
and removed on exit. Each scan has its own immutable source, image inspection,
full Trivy JSON, scanner/database metadata and build logs. Future database updates
can change findings: the immutable input does not guarantee a clean scan.

The smoke runner uses fresh local TLS credentials, an internal Docker network,
no published ports, capability drops, no privilege escalation, 1 CPU and 256 PIDs
per service, Kafka 1536 MiB/Cassandra 2 GiB limits and 512 MiB JVM heaps. Services
run sequentially. Its volume is created specifically for a 5.0.5→5.0.9 Cassandra
fixture upgrade and removed on exit; it never mounts deployment volumes. It
checks KRaft SASL_SSL/ACL behavior and CQL TLS/auth/permissions/persisted data/TTL.
The Kafka fixture event models an outbox payload but does not prove actual
Debezium CDC, Connect, schema registry, multi-broker upgrades or replication.
The Cassandra fixture demonstrates a single-node SSTable patch upgrade, not
RF3 repair/rolling upgrades or the complete application schema.

Evidence and unresolved source rebuild requirements are in
`.superpowers/platform-closure/task-3-report.md`. Neither immutable source pin
nor local BuildKit attestation establishes approved vendor provenance or a
release signature. Those approvals remain independent gates.

Fix round 1: scan summaries require one Docker inspection and expected service per
report, validate result/package/vulnerability shapes and match immutable image IDs
and service versions. Legitimate omitted/null vulnerability arrays are accepted
only with complete analyzed inventories. Invalid evidence produces no trusted
findings.json. The smoke runner resolves candidate tags once to immutable IDs; its
baseline override must be a digest and runtime queries must report exactly 5.0.5
and 5.0.9 before SSTable upgrade proof. Every created resource has a unique ownership
label and a reserved name before creation, including keytool and source preparation.
cleanup.json records each removal verification, logging error, and credential
deletion; failed/unverified cleanup fails the run. Local Cassandra probes also cap
JVM CPU detection/direct memory to 1 CPU/256 MiB and bound CQL connection/request
timeouts; deployment resources and server images are unchanged.
