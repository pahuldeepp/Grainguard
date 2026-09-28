# The root Application is installed only when a release commit and the exact
# digest manifest are supplied. Argo then reads that immutable commit, never
# a mutable branch. The main readiness gate still blocks a real apply while
# data, secrets, migrations, and live acceptance are incomplete.
variable "enable_application_tree" {
  description = "Install the Terraform-owned root Argo CD Application after supplying a complete pinned release manifest."
  type        = bool
  default     = false
}

variable "gitops_repository_url" {
  description = "HTTPS Git repository readable by Argo CD and containing the disposable applications chart."
  type        = string
  default     = "https://github.com/pahuldeepp/Grainguard.git"
  validation {
    condition     = can(regex("^https://[^ ]+\\.git$", var.gitops_repository_url))
    error_message = "gitops_repository_url must be an HTTPS .git repository URL."
  }
}

variable "gitops_revision" {
  description = "Exact 40-character Git commit containing the application tree and Helm charts."
  type        = string
  default     = ""
  validation {
    condition     = var.gitops_revision == "" || can(regex("^[a-f0-9]{40}$", var.gitops_revision))
    error_message = "gitops_revision must be an exact lowercase 40-character Git commit SHA."
  }
}

variable "deployment_image_digests" {
  description = "Image name to full immutable OCI digest reference, promoted by CI; no mutable tags."
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([
      for _, digest in var.deployment_image_digests :
      can(regex("^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", digest))
    ])
    error_message = "Every deployment image must be a full immutable OCI digest reference."
  }
}

variable "migration_image_digests" {
  description = "Exactly eleven immutable migration-target images, separately built from runtime images. Keys are control, billing, telemetry, projection, jobs, saga, hardware, inventory, alerts, risk and notifications."
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for digest in values(var.migration_image_digests) : can(regex("^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", digest))])
    error_message = "Every owner migration image must be a full immutable OCI digest reference."
  }
}

variable "migration_gate_image_digest" {
  description = "Digest-pinned kubectl image with /bin/sh, used only by the read-only owner migration completion gate."
  type        = string
  default     = ""
  validation {
    condition     = var.migration_gate_image_digest == "" || can(regex("^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.migration_gate_image_digest))
    error_message = "migration_gate_image_digest must be a full immutable OCI digest reference."
  }
}

variable "migration_sql_image_digest" {
  description = "Digest-pinned PostgreSQL client image with psql and bash, used only by owner migration and SQL acceptance Jobs."
  type        = string
  default     = ""
  validation {
    condition     = var.migration_sql_image_digest == "" || can(regex("^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.migration_sql_image_digest))
    error_message = "migration_sql_image_digest must be a full immutable OCI digest reference."
  }
}

variable "observability_image_digests" {
  description = "Exactly five immutable image references for the disposable OTel Collector, Prometheus, Grafana, Tempo and Loki stack."
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([
      for _, digest in var.observability_image_digests :
      can(regex("^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", digest))
    ])
    error_message = "Every observability image must be a full immutable OCI digest reference."
  }
}

variable "data_plane_image_digests" {
  description = "Exactly four immutable images for disposable PgBouncer, Kafka topic bootstrap, Kafka Connect and connector registration."
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([
      for _, digest in var.data_plane_image_digests :
      can(regex("^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", digest))
    ])
    error_message = "Every data-plane image must be a full immutable OCI digest reference."
  }
}

variable "opensearch_image_digest" {
  description = "Immutable OpenSearch server image for the private disposable search Application."
  type        = string
  default     = ""
  validation {
    condition     = var.opensearch_image_digest == "" || can(regex("^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.opensearch_image_digest))
    error_message = "opensearch_image_digest must be a full immutable OCI digest reference."
  }
}

variable "cassandra_image_digest" {
  description = "Immutable Cassandra server image for the private disposable history Application."
  type        = string
  default     = ""
  validation {
    condition     = var.cassandra_image_digest == "" || can(regex("^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.cassandra_image_digest))
    error_message = "cassandra_image_digest must be a full immutable OCI digest reference."
  }
}

variable "mqtt_image_digest" {
  description = "Immutable Mosquitto image for the private disposable MQTT broker."
  type        = string
  default     = ""
  validation {
    condition     = var.mqtt_image_digest == "" || can(regex("^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.mqtt_image_digest))
    error_message = "mqtt_image_digest must be a full immutable OCI digest reference."
  }
}

variable "application_acceptance_timeout_seconds" {
  description = "Maximum time for Argo-created application, owner migrations, and the PostgreSQL SQL/RLS admission gate to become healthy after bootstrap."
  type        = number
  default     = 2400
  validation {
    condition     = var.application_acceptance_timeout_seconds >= 60 && var.application_acceptance_timeout_seconds <= 3600 && floor(var.application_acceptance_timeout_seconds) == var.application_acceptance_timeout_seconds
    error_message = "application_acceptance_timeout_seconds must be an integer from 60 through 3600."
  }
}

locals {
  deployment_contract = jsondecode(file("${path.module}/../../gitops/disposable/contract.json"))
  required_images     = toset([for release in local.deployment_contract.releases : release.image])
  required_runtime_secret_names = setunion(
    toset([for release in local.deployment_contract.releases : release.secret if release.name != "dashboard"]),
    toset([for shard_id in local.postgres_shard_ids : "greenguard-${shard_id}-projection-history-maintenance-config"])
  )
  required_bootstrap_secret_names = toset(["greenguard-rds-bootstrap", "greenguard-rds-ca"])
  migration_owner_names           = toset(["control", "billing", "telemetry", "projection", "jobs", "saga", "hardware", "inventory", "alerts", "risk", "notifications"])
  required_migration_secret_names = toset(concat(
    ["greenguard-control-migration", "greenguard-billing-migration"],
    flatten([for shard_id in local.postgres_shard_ids : [for owner in ["telemetry", "projection", "jobs", "saga", "hardware", "inventory", "alerts", "risk", "notifications"] : "greenguard-${shard_id}-${owner}-migration"]])
  ))
  required_observability_images = toset(["otel-collector", "prometheus", "grafana", "tempo", "loki"])
  required_data_plane_images    = toset(["pgbouncer", "kafka-topics", "kafka-connect", "connector-registration"])
  required_data_plane_secrets   = toset(["greenguard-pgbouncer-auth", "greenguard-cdc-credentials", "greenguard-kafka-auth", "greenguard-kafka-ca", "greenguard-kafka-connect-auth", "greenguard-kafka-admin-auth", "greenguard-opensearch-admin", "greenguard-opensearch-clients", "greenguard-opensearch-tls", "greenguard-opensearch-ca", "greenguard-cassandra-auth", "greenguard-cassandra-tls", "greenguard-mqtt-broker"])
  shard_registry_by_release = {
    "device-service"                  = { service = "device-service", secret = "device-service", env = "SHARD_REGISTRY_FILE" }
    "telemetry-ingest"                = { service = "telemetry-ingest", secret = "telemetry-ingest", env = "SHARD_REGISTRY_FILE" }
    "projection-builder"              = { service = "projection-builder", secret = "projection-builder", env = "SHARD_REGISTRY_FILE" }
    "risk-engine"                     = { service = "risk-engine", secret = "risk-engine", env = "SHARD_REGISTRY_FILE" }
    "workflow-alerts"                 = { service = "workflow-alerts", secret = "workflow-alerts", env = "SHARD_REGISTRY_FILE" }
    "jobs-worker"                     = { service = "jobs-worker", secret = "jobs-worker", env = "SHARD_REGISTRY_FILE" }
    "notification-service"            = { service = "notification-service", secret = "notification-service", env = "SHARD_REGISTRY_FILE" }
    "saga-api"                        = { service = "saga-orchestrator", secret = "saga-orchestrator", env = "SHARD_REGISTRY_FILE" }
    "saga-worker"                     = { service = "saga-orchestrator", secret = "saga-orchestrator", env = "SHARD_REGISTRY_FILE" }
    "hardware-service-worker"         = { service = "hardware-service", secret = "hardware-service", env = "SHARD_REGISTRY_FILE" }
    "tenant-control-plane"            = { service = "audit-export-worker", secret = "audit-export-worker", env = "INVENTORY_SHARD_REGISTRY_FILE" }
    "read-api"                        = { service = "read-api", secret = "read-api", env = "READ_SHARD_REGISTRY_FILE" }
    "audit-export-worker"             = { service = "audit-export-worker", secret = "audit-export-worker", env = "INVENTORY_AUDIT_SHARD_REGISTRY_FILE" }
    "device-saga-worker"              = { service = "device-service", secret = "device-service", env = "SHARD_REGISTRY_FILE" }
    "device-tenant-projector"         = { service = "device-service", secret = "inventory-projector", env = "SHARD_REGISTRY_FILE" }
    "inventory-entitlement-projector" = { service = "device-service", secret = "inventory-projector", env = "SHARD_REGISTRY_FILE" }
    "telemetry-entitlement-projector" = { service = "telemetry-ingest", secret = "telemetry-entitlement-projector", env = "SHARD_REGISTRY_FILE" }
    "read-entitlement-projector"      = { service = "read-entitlement-projector", secret = "read-entitlement-projector", env = "SHARD_REGISTRY_FILE" }
  }
  # Public identifiers come from the selected existing OIDC provider or the
  # explicitly opted-in disposable Cognito pool. Credentials remain in Secrets.
  oidc_membership_env = concat(local.oidc_verifier_env, [
    { name = "AUTH_MEMBERSHIP_SOURCE", value = "control-plane" },
    { name = "CONTROL_PLANE_URL", value = "http://tenant-control-plane.greenguard.svc.cluster.local:3010" },
  ])
  # The application sends HTTP to its local Envoy; the pod hop is strict mTLS.
  # Notification's live-provider config permits this only for the exact
  # tenant-control-plane Service FQDN/port. Device import auth remains an
  # optional all-or-nothing Secret bundle (including CONTROL_LOOKUP_URL).
  mesh_http_releases = toset(["device-service", "notification-service"])
  membership_verifier_releases = toset([
    "bff", "gateway", "device-service", "read-api", "workflow-alerts", "notification-service"
  ])
  otel_http_releases = toset([
    "device-service", "workflow-alerts", "tenant-control-plane", "telemetry-ingest",
    "cdc-transformer", "projection-builder", "cassandra-writer"
  ])
  otel_http_env = [{
    name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
    value = "http://otel-collector.greenguard.svc.cluster.local:4318"
  }]
  application_release_inputs = [for release in local.deployment_contract.releases : merge(release, {
    # A missing profile resolves through try() to a path that does not exist,
    # yielding {} without a conditional between structurally different types.
    baseValues    = try(yamldecode(file("${path.module}/../../helm/${release.chart}/values/${try(release.profile, "no-profile")}.yaml")), {})
    shardRegistry = lookup(local.shard_registry_by_release, release.name, null)
  })]
  application_releases = [for release in local.application_release_inputs : {
    name                 = release.name
    chart                = release.chart
    profile              = try(release.profile, null)
    baseValues           = release.baseValues
    shardRegistry        = release.shardRegistry
    shardRoutingRequired = release.shardRegistry != null
    imageDigest          = lookup(var.deployment_image_digests, release.image, "")
    extraValues = merge(
      { for key, value in {
        publicOidc = local.oidc_dashboard_values.publicOidc
      } : key => value if release.name == "dashboard" && local.oidc_dashboard_values != null },
      { for key, value in {
        env = concat(local.oidc_membership_env, [
          { name = "KAFKA_REQUIRE_TLS", value = "true" },
          { name = "KAFKA_SECURITY_PROTOCOL", value = "SASL_SSL" },
          { name = "KAFKA_SASL_MECHANISM", value = "PLAIN" },
          { name = "KAFKA_TLS_CA_FILE", value = "/etc/greenguard/kafka/ca.crt" },
        ])
        envFrom             = [{ secretRef = { name = release.secret } }]
        postgresReadReplica = { caSecretName = "greenguard-rds-ca" }
        kafka               = { caSecretName = "greenguard-kafka-ca" }
      } : key => value if release.name == "bff" },
      { for key, value in {
        container = merge(
          try(release.baseValues.container, {}),
          { envFrom = concat(try(release.baseValues.container.envFrom, []), [{ secretRef = { name = release.secret } }]) },
          { volumeMounts = concat(
            try(release.baseValues.container.volumeMounts, []),
            release.shardRegistry != null ? [{ name = "shard-registry", mountPath = "/run/greenguard-shards", readOnly = true }] : [],
            release.name == "hardware-service-worker" ? [{ name = "mqtt-ca", mountPath = "/etc/greenguard/mqtt", readOnly = true }] : []
          ) },
          { env = concat(
            try(release.baseValues.container.env, []),
            contains(local.membership_verifier_releases, release.name) ? (release.shardRegistry != null ? concat(local.oidc_verifier_env, [{ name = "AUTH_MEMBERSHIP_SOURCE", value = "control-plane" }]) : local.oidc_membership_env) : release.name == "tenant-control-plane" ? local.oidc_verifier_env : [],
            release.shardRegistry != null ? [
              { name = "CONTROL_PLANE_URL", value = "http://tenant-control-plane.greenguard.svc.cluster.local:3010" },
              { name = "CONTROL_PLANE_MESH_MTLS", value = "true" },
            ] : [],
            contains(local.otel_http_releases, release.name) ? local.otel_http_env : [],
            contains(local.mesh_http_releases, release.name) ? [{ name = "GG_MESH_INTERNAL_HTTP", value = "1" }] : [],
            release.name == "audit-export-worker" ? [] : [
              { name = "KAFKA_REQUIRE_TLS", value = "true" },
              { name = "KAFKA_SECURITY_PROTOCOL", value = "SASL_SSL" },
              { name = "KAFKA_SASL_MECHANISM", value = "PLAIN" },
              { name = "KAFKA_TLS_CA_FILE", value = "/etc/greenguard/kafka/ca.crt" },
            ],
            release.shardRegistry != null ? [
              { name = "SHARD_ROUTING_REQUIRED", value = "true" },
              { name = release.shardRegistry.env, value = "/run/greenguard-shards/registry.json" },
            ] : [],
            release.name == "hardware-service-worker" ? [
              { name = "MQTT_BROKER_URL", value = "tls://mqtt.greenguard.svc.cluster.local:8883" },
              { name = "MQTT_CA_FILE", value = "/etc/greenguard/mqtt/ca.crt" },
              { name = "MQTT_CLIENT_ID", value = "greenguard-hardware-worker" },
            ] : []
          ) },
        )
        postgresReadReplica = { caSecretName = "greenguard-rds-ca" }
        kafka               = release.name == "audit-export-worker" ? { caSecretName = "" } : { caSecretName = "greenguard-kafka-ca" }
        volumes = concat(
          try(release.baseValues.volumes, []),
          release.name == "hardware-service-worker" ? [{ name = "mqtt-ca", secret = { secretName = "greenguard-mqtt-broker", items = [{ key = "ca.crt", path = "ca.crt" }] } }] : [],
          release.shardRegistry != null ? [{ name = "shard-registry", secret = { secretName = "greenguard-shard-routing-${release.shardRegistry.secret}", defaultMode = 288, items = [{ key = "registry.json", path = "registry.json" }] } }] : []
        )
      } : key => value if release.chart == "greenguard-service" },
      { for key, value in { mesh = { enabled = true, strictMtls = true } } : key => value if contains(
        toset(["greenguard-dashboard", "greenguard-bff", "greenguard-service"]),
        release.chart
      ) },
      { observability = {
        collector = {
          enabled   = contains(local.otel_http_releases, release.name)
          namespace = "greenguard"
          selector  = { app = "otel-collector" }
          otlpPort  = 4318
        }
        prometheus = {
          enabled           = true
          namespace         = "greenguard"
          selector          = { app = "prometheus" }
          mergeMetrics      = true
          scrapePort        = 15020
          allowedPrincipals = []
        }
      } },
      { for key, value in { networkPolicy = {
        egressCIDRs = var.enable_application_tree ? [for cidr in data.aws_prefix_list.dynamodb[0].cidr_blocks : { cidr = cidr, port = 443 }] : []
      } } : key => value if release.name == "notification-contacts-projector" },
      { for key, value in { networkPolicy = {
        egressCIDRs = var.enable_application_tree ? [for cidr in data.aws_prefix_list.s3[0].cidr_blocks : { cidr = cidr, port = 443 }] : []
      } } : key => value if contains(toset(["audit-export-worker", "tenant-control-plane"]), release.name) }
    )
  }]
}

resource "helm_release" "gitops_bootstrap" {
  count     = var.enable_application_tree ? 1 : 0
  name      = "greenguard-argocd-bootstrap"
  namespace = "argocd"
  chart     = "${path.module}/../../gitops/disposable/bootstrap-chart"
  atomic    = true
  wait      = true
  timeout   = 900
  values = [yamlencode({
    cell          = var.cluster_name
    repositoryUrl = var.gitops_repository_url
    revision      = var.gitops_revision
    releases      = local.application_releases
    ownerMigrations = {
      images    = var.migration_image_digests
      gateImage = var.migration_gate_image_digest
      sqlImage  = var.migration_sql_image_digest
      caSecret  = "greenguard-rds-ca"
      scopes = merge({
        central = {
          rdsHost = aws_db_instance.postgres.address
          secrets = {
            control = "greenguard-control-migration"
            billing = "greenguard-billing-migration"
          }
        }
        }, { for shard_id, shard in aws_db_instance.shard : shard_id => {
          rdsHost = shard.address
          secrets = {
            for owner in ["telemetry", "projection", "jobs", "saga", "hardware", "inventory", "alerts", "risk", "notifications"] :
            owner => "greenguard-${shard_id}-${owner}-migration"
          }
      } })
      rdsCIDRs      = [for subnet in aws_subnet.private : subnet.cidr_block]
      apiServerCIDR = "${cidrhost(aws_eks_cluster.cell.kubernetes_network_config[0].service_ipv4_cidr, 1)}/32"
    }
    observabilityImages = var.observability_image_digests
    dataPlane = {
      enabled = true
      rdsHost = aws_db_instance.postgres.address
      images  = var.data_plane_image_digests
      projectionMaintenance = {
        image    = lookup(var.deployment_image_digests, "projection-builder", "")
        rdsCIDRs = [for subnet in aws_subnet.private : subnet.cidr_block]
      }
      shards = { for shard_id, shard in aws_db_instance.shard : shard_id => {
        rdsHost                     = shard.address
        bootstrapSecret             = "greenguard-${shard_id}-rds-bootstrap"
        pgbouncerAuthSecret         = "greenguard-${shard_id}-pgbouncer-auth"
        cdcSecret                   = "greenguard-${shard_id}-cdc-credentials"
        projectionMaintenanceSecret = "greenguard-${shard_id}-projection-history-maintenance-config"
      } }
      secrets = {
        pgbouncerAuth  = "greenguard-pgbouncer-auth"
        rdsCa          = "greenguard-rds-ca"
        cdcCredentials = "greenguard-cdc-credentials"
      }
    }
    searchPlane = {
      enabled        = true
      image          = var.opensearch_image_digest
      bootstrapImage = lookup(var.deployment_image_digests, "search-indexer", "")
    }
    cassandraPlane = {
      enabled       = true
      image         = var.cassandra_image_digest
      migratorImage = lookup(var.deployment_image_digests, "cassandra-writer", "")
      authSecret    = "greenguard-cassandra-auth"
      tlsSecret     = "greenguard-cassandra-tls"
      # EKS uses the first IPv4 address in its Kubernetes Service CIDR for
      # kubernetes.default. Confirm actual Service IP before live release.
      apiServerCIDR = "${cidrhost(aws_eks_cluster.cell.kubernetes_network_config[0].service_ipv4_cidr, 1)}/32"
    }
    mqttPlane = {
      enabled          = true
      image            = var.mqtt_image_digest
      credentialSecret = "greenguard-mqtt-broker"
    }
  })]

  lifecycle {
    precondition {
      condition     = var.gitops_revision != "" && length(setsubtract(local.required_images, toset(keys(var.deployment_image_digests)))) == 0 && length(setsubtract(toset(keys(var.deployment_image_digests)), local.required_images)) == 0
      error_message = "Application tree needs an exact Git commit and one immutable digest for every and only every published image in contract.json."
    }
    precondition {
      condition     = length(setsubtract(setunion(local.required_runtime_secret_names, local.required_bootstrap_secret_names, local.required_data_plane_secrets, local.required_migration_secret_names, toset(["grafana-admin"])), var.secret_names)) == 0
      error_message = "Application tree needs Secrets Manager containers for runtime, bootstrap, migration, data-plane credentials and grafana-admin; Terraform must materialize complete values before deployment."
    }
    precondition {
      condition     = toset(keys(var.migration_image_digests)) == local.migration_owner_names && var.migration_gate_image_digest != "" && var.migration_sql_image_digest != ""
      error_message = "Application tree needs exactly eleven separately built immutable owner-migration images plus digest-pinned kubectl and psql tool images."
    }
    precondition {
      condition     = length(setsubtract(local.required_observability_images, toset(keys(var.observability_image_digests)))) == 0 && length(setsubtract(toset(keys(var.observability_image_digests)), local.required_observability_images)) == 0
      error_message = "Application tree needs exactly five digest-pinned observability images."
    }
    precondition {
      condition     = length(setsubtract(local.required_data_plane_images, toset(keys(var.data_plane_image_digests)))) == 0 && length(setsubtract(toset(keys(var.data_plane_image_digests)), local.required_data_plane_images)) == 0
      error_message = "Application tree needs exactly four digest-pinned data-plane images."
    }
    precondition {
      condition     = var.opensearch_image_digest != ""
      error_message = "Application tree needs a digest-pinned OpenSearch image and the search-indexer runtime digest for certificate preflight and index bootstrap."
    }
    precondition {
      condition     = var.cassandra_image_digest != ""
      error_message = "Application tree needs a digest-pinned Cassandra image and the cassandra-writer runtime digest for secure schema bootstrap."
    }
    precondition {
      condition     = var.mqtt_image_digest != ""
      error_message = "Application tree needs a digest-pinned private MQTT broker image."
    }
  }

  depends_on = [helm_release.argocd, helm_release.greenguard_namespace, terraform_data.runtime_secret_sync, aws_eks_pod_identity_association.notification_contacts_projector, aws_eks_pod_identity_association.audit_export]
}

# Argo applies the child Applications asynchronously after this Helm release
# installs the root Application. Keep the technical health gate separate from
# the Helm resource so a readiness timeout does not taint/recreate bootstrap.
resource "terraform_data" "deployed_workload_acceptance" {
  count = var.enable_application_tree ? 1 : 0
  input = {
    cell_identity = {
      account_id   = var.target_account_id
      region       = var.aws_region
      environment  = var.environment
      cluster_name = var.cluster_name
    }
    release = {
      gitops_revision             = var.gitops_revision
      deployment_image_digests    = var.deployment_image_digests
      migration_image_digests     = var.migration_image_digests
      migration_gate_image_digest = var.migration_gate_image_digest
      migration_sql_image_digest  = var.migration_sql_image_digest
    }
  }
  # Helm revision changes for any root Application value update, including
  # OIDC, Secret references, shard routing and infrastructure endpoints.
  triggers_replace = helm_release.gitops_bootstrap[0].metadata.revision
  depends_on       = [helm_release.gitops_bootstrap]

  provisioner "local-exec" {
    command = "python3 ${path.module}/../../gitops/disposable/run-deployed-workloads.py"
    environment = {
      GG_DISPOSABLE_CELL_IDENTITY              = jsonencode(self.input.cell_identity)
      GG_DISPOSABLE_RELEASE_INPUTS             = jsonencode(self.input.release)
      GG_DISPOSABLE_ACCEPTANCE_TIMEOUT_SECONDS = tostring(var.application_acceptance_timeout_seconds)
    }
    quiet = true
  }
}
