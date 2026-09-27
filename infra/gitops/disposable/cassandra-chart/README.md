# Disposable Cassandra CQL security candidate

This chart renders only with immutable Cassandra and migrator image digests plus
names of pre-populated `authSecret` and `tlsSecret`. It never creates credential
values. `authSecret` must contain `admin-password`, `reader-password`, and
`writer-password`, each 16 or more ASCII letters, digits, `_` or `-` (the
bootstrap Job rejects other characters). `tlsSecret` must contain
`server.p12`, `keystore-password`, and `ca.crt`. The PKCS12 certificate must
have a DNS SAN for `greenguard-cassandra` (and preferably its namespace-qualified
name), be signed by `ca.crt`, and use the supplied keystore password.
`apiServerCIDR` must be the exact `/32` of the in-cluster Kubernetes API
Service IP. The activator's egress is limited to that IP on TCP/443, the
three Cassandra Jobs' egress is limited to DNS and the Cassandra pod on
TCP/9042, and the Cassandra pod only permits those Job identities until the
auth-ready gate opens. The EKS VPC CNI's handling of the Service IP after
NAT still requires a live reachability check; a wrong IP fails activation.

The pinned Cassandra 5 image's own `cassandra.yaml` is copied to an emptyDir
and patched to `PasswordAuthenticator`, `CassandraAuthorizer`, and TLS-only
`client_encryption_options` using the PKCS12 keystore. The pod runs as UID/GID
999. A bounded TLS handshake readiness check validates the CA and DNS name.
The default `cassandra`/`cassandra` superuser is rotated by a PostSync wave-0
Job. Wave 1 uses `/usr/local/bin/cassandra-migrate` from the writer image to
create and verify the RF1 history schema over authenticated, verified CQL.
Wave 2 grants `SELECT` to the reader role and `MODIFY`/`SELECT` to the writer
role. The client NetworkPolicy selects only Cassandra pods with
`greenguard.io/cassandra-auth-ready=true`; new pods start with that label
`false`. A wave-3 Job, limited by RBAC to `get`/`patch` on
`greenguard-cassandra-0`, first verifies CQL TLS and that the default
`cassandra`/`cassandra` login is rejected while the rotated admin login works,
then adds the ready label after the grants Job succeeds.
This closes the fresh-pod/PVC replacement exposure from a previously existing
client policy. The base NetworkPolicy admits only labeled bootstrap/schema/
grants Jobs during the default-password window.

Runtime clients must use `CASSANDRA_REQUIRE_SECURE=1`,
`CASSANDRA_HOSTS=greenguard-cassandra`, the matching username/password,
`CASSANDRA_TLS_CA_FILE` mounted from the TLS Secret, and
`CASSANDRA_TLS_SERVER_NAME=greenguard-cassandra`. Read API uses
`gg_history_reader`; writer uses `gg_history_writer`. Secret population,
certificate issuance/renewal, ECR image promotion, Argo wiring, and runtime
NetworkPolicy egress remain separate gates.

This is a static candidate, **not live acceptance**. The bootstrap ordering and
NetworkPolicy were rendered and checked offline, but no Kubernetes secure CQL
handshake, role grant, Cassandra restart, or partial-sync recovery has run.
An in-place data wipe or server restart inside the *same* already-activated Pod
could retain its ready label while Cassandra recreates the default superuser.
That destructive path needs admission/operational controls and live proof before
claiming the default-password window is fully closed. The single replica/RF1
profile is disposable, not multi-AZ. PVC and EBS volume removal still need live
teardown inventory proof. Secret rotation after administrator password change
also needs a tested procedure; blindly replacing the Secret will fail closed.

Run `bash infra/gitops/disposable/cassandra-chart/check-offline.sh` for the
static render gate.
