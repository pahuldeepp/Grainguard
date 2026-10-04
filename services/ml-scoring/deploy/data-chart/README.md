# Isolated synthetic data plane

This chart is a disposable one-node PostgreSQL + Kafka environment for the
synthetic-only ML scorer. It is not a production database, a Kafka HA cluster,
or part of GreenGuard's real tenant data plane. `enabled` defaults to false,
all images must stay digest pinned, Kafka has RF=1/min ISR=1, and each service
has a single replica. The chart can only render in namespace `ml-synthetic`.

## Provisioned resources

- `postgres` StatefulSet and ClusterIP service. It uses a gp3 PVC, TLS server
  certificate, SCRAM-SHA-256 password auth, and a `hostssl`-only pg_hba rule.
  The one-time init creates a bootstrap superuser, a dedicated database-owner
  `ml_migrator`, and a runtime `ml_app` login with `NOBYPASSRLS`. The migration
  job later grants `ml_app` only the scorer's required tables/operations.
- One KRaft broker with TLS and SCRAM-SHA-512. First boot seeds only three
  principals (admin, scorer, fixture producer) into the metadata log, disables
  auto topic creation, and keeps 48-hour topic retention. Broker storage is on
  its own gp3 PVC.
- A post-sync Kafka bootstrap Job creates the canonical input and shadow output
  topics and exact topic/group ACLs. The scorer can read the input topic, join
  only its fixed consumer group, and write only the shadow topic; the fixture
  principal can write only to the input topic.
- Deny-by-default network policies permit PostgreSQL access only from scorer
  pods and Kafka access only from scorer/bootstrap pods in `ml-synthetic`.

The volume claim templates use StatefulSet retention policy `whenDeleted:
Delete`; removing the data StatefulSet deletes its PVCs. The StorageClass must
use a Delete reclaim policy. Verify the resulting EBS inventory during the
parent environment's teardown acceptance; this chart alone is not proof that
cloud storage has been removed.

## External Secret contract

The chart reads Secrets; it never renders or generates credential values.
Generate a short-lived local bundle using
`../generate_synthetic_secrets.py --output-dir <owner-only-directory>`. The
generator requires `openssl` and `keytool`, creates files with mode 0600 in a
0700 directory, prints no values, and creates 30-day TLS certificates. Its
outputs map as follows:

| Kubernetes Secret | Required keys |
| --- | --- |
| `ml-synthetic-postgres-auth` | `bootstrap-password`, `migrator-password`, `runtime-password`, `server.crt`, `server.key`, `ca.crt` |
| `ml-synthetic-kafka-auth` | `admin-password`, `scorer-password`, `fixture-password`, `broker-jaas`, `inter-broker-jaas` |
| `ml-synthetic-kafka-tls` | `broker.keystore.p12`, `broker.truststore.p12`, `keystore-password`, `key-password`, `truststore-password`, `ca.crt` |
| `ml-scoring-runtime` | `database-url`, `kafka-username`, `kafka-password`, `operations-token` |
| `ml-scoring-migrator` | `database-url` |
| `ml-scoring-fixture` | `kafka-username`, `kafka-password` |

The broker certificate has SANs for the bootstrap Service and advertised
headless broker DNS name. Generated passwords are hexadecimal to fit Kafka's
initial SCRAM formatting contract and URI-encode safely. The `ml_migrator` DSN
and `ml_app` DSN use the exact `postgres.ml-synthetic.svc.cluster.local`
hostname, `greenguard_ml` database, and `sslmode=verify-full` with
`/var/run/postgres-tls/root.crt`. Never reuse the generated credentials outside
this throwaway namespace. Delete the bundle directory after creating the
Kubernetes Secrets and record certificate/password rotation as an environment
operation; this helper is not a production PKI or rotation system.

Credential rotation is deliberately disabled in-place. PostgreSQL stores role
passwords on its persistent volume and Kafka stores SCRAM credentials in KRaft
metadata; changing the Kubernetes/Secrets Manager bundle alone would strand
the services. To replace this synthetic bundle, destroy the disposable cell,
generate a new bundle, and recreate it from an empty data plane.

## Install order and limits

The root Argo application must install this chart as a separate opt-in child
Application in an earlier sync wave, wait for PostgreSQL and Kafka readiness,
and wait for the post-sync topic/ACL Job to complete before it enables the
scorer chart. Then the scorer chart runs its own pre-sync schema migration.
Both Applications must use exact immutable image references and remain
disabled until the parent environment has materialized the Secrets.

This chart does not seed real identity-provider membership. Its fixed synthetic
tenant UUID is only the scoring isolation key; do not make it a general tenant
or surface its observations to ordinary user accounts. A dedicated test
principal or explicit operator-only demo-tenant mapping is required to exercise
the ML operations UI. No predictions from this isolated chart may affect product
risk state, alerts, billing, or customer decisions. One node per database/broker
means there is no HA or failover acceptance here.
