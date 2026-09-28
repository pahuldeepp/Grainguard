# Owner migration slice

`services/telemetry-ingest/Dockerfile`, `services/projection-builder/Dockerfile`,
`services/jobs-worker/Dockerfile`, `services/saga-orchestrator/Dockerfile`, and
`services/hardware-service/Dockerfile` have separate `--target migration`
images. Each compiles its existing Go migrator and embeds its SQL migrations.
The four Prisma owners (`device-service`, `workflow-alerts`,
`tenant-control-plane`, and `billing-service`) also have migration targets;
these retain the Prisma CLI and migration files while runtime stages prune
development dependencies. The final Dockerfile stage remains the runtime
image. `risk-engine` has a Python migration target; `notification-service`
has a Node migration target that runs its compiled ledger migrator. Publish
all eleven images to ECR and pass immutable digests as
`telemetryImage`, `projectionImage`, `jobsImage`, `sagaImage`,
`hardwareImage`, `inventoryImage`, `alertsImage`, `controlImage`,
`billingImage`, `riskImage`, and `notificationsImage`.
This chart rejects missing or mutable images.

The eleven `*-migrator-config` Job Secrets must contain their corresponding
`*_MIGRATION_URL` key. Each URL must connect directly to RDS as its schema
owner and include `sslmode=verify-full&sslrootcert=/rds-ca/ca.pem` (URL encode
the path if required by the secret generator). The Jobs set `GG_RDS=1`, and
the shared Go migrator and Node/Python migration image URL guards reject weaker
TLS settings before connecting. The
`greenguard-rds-ca` Secret must contain `ca.pem`. Passwords and full URLs must
never appear in Helm values or Terraform state.

The eleven known PostgreSQL schema owners now have dedicated image and Job
templates. The wave-25 `migration-gate-chart` remains deliberately closed,
and these Jobs are not yet added to the Argo tree. Digest promotion,
credential delivery, ordered execution after RDS bootstrap, and live RLS
validation must be proved before runtime wave 30 can be released.
