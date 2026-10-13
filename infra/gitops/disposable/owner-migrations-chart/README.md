# Owner migration orchestration

The wave-24 Application runs 38 Jobs: control and billing in the central
RDS instance, then nine operational owners in each of s1, s2, s3 and s4.
`../owner-migration-inventory.json` lists the independent owner inventory.
Migration images must be built with each owner's Dockerfile `--target migration`;
runtime image digests are separate inputs.

The root Application accepts `ownerMigrations` with:

- `images`: eleven owner keys mapped to immutable migration image digests.
- `scopes`: `central`, `s1`, `s2`, `s3`, `s4`; each contains a distinct direct
  `rdsHost` and `secrets` mapping owner names to Kubernetes Secret names.
  Central requires control/billing; each shard requires the other nine owners.
- `caSecret`: a Secret containing `ca.pem`.
- `sqlImage`: immutable image providing `/bin/bash`, `/bin/sh` and `psql`.
- `gateImage`: immutable image providing `/bin/sh` and `kubectl`.
- `rdsCIDRs`: private RDS subnet IPv4 CIDRs, prefix lengths 16–32.
- `apiServerCIDR`: the Kubernetes Service API IPv4 address with prefix `/32`.

The root supplies its immutable Git `revision`. Helm values contain no passwords
or connection strings. Scoped migrator Secrets contain the corresponding
`*_MIGRATION_URL` key. URLs must select the exact schema-owner role, expected
RDS host on port 5432 and expected database; they must include
`sslmode=verify-full&sslrootcert=/rds-ca/ca.pem` (encoded paths accepted).
Only `application_name` and bounded `connect_timeout` are additional accepted
parameters. The SQL preflight validates identity before invoking the image's
migration entrypoint. Failed mounts, registry pulls, TLS, credentials or checks
keep the release closed.

The wave-25 gate waits for the exact 38 Job names and executes catalog checks
using each scoped migrator Secret. Checks cover identity, schema, runtime SELECT
privileges, forced RLS/policies and operational row/truncate ownership fences;
control also checks ephemeral read-lease release and immutable audit privileges.
Only the Job-wait container mounts the scoped Kubernetes API token. SQL uses
bounded connect, statement and lock timeouts. Jobs disable Istio sidecar injection
to allow completion; direct PostgreSQL connections require verified TLS.
NetworkPolicies deny inbound traffic and allow only cluster DNS, configured RDS
subnets on 5432, and (for the gate pod) the API address on 443.

Argo must install an `argoproj.io/Application` health customization that reports
Healthy only when child `status.sync.status` is Synced and child
`status.health.status` is Healthy. Parent sync waves alone do not prove child Job
completion. Namespace and CA/scoped Secrets must exist before wave 24; bootstrap
must finish first. Runtime wave 30 follows the gate. Terraform must pass the full
contract above and the health customization; readiness flags are not evidence.
Job names include revision, image and target configuration hashes, so changed
release targets do not reuse an already completed immutable Job.

`ruby ../check-owner-migrations.rb` validates render coverage, exact dependencies,
security boundaries and invalid configurations without AWS access or applying
resources. It proves the offline contract; real registry delivery, bootstrap,
migration execution and Argo health remain deployment acceptance requirements.

The owner Job revision hash now includes the owner descriptor, exact Git revision,
owner image, target RDS host, migrator Secret, CA Secret, psql image, gate image,
RDS CIDRs and API-server CIDR. Gate image/API changes conservatively refresh the
owner Job dependency set as well as the gate Job. The Application, owner Job and
gate helpers use the same deterministic inputs. This prevents completed immutable
Jobs from being reused after migration or verification behavior changes.
`test-owner-migration-revisions.rb` mutates these inputs and checks that the gate
waits for the matching new Job names; it also verifies that a new top-level Git
revision overrides a stale nested revision in both child Applications.
