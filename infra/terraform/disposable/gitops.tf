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
  description = "SSH URL for the private GitHub repository readable by its repo-scoped read-only deploy key."
  type        = string
  default     = "ssh://git@github.com/pahuldeepp/Grainguard.git"
  validation {
    condition     = var.gitops_repository_url == "ssh://git@github.com/pahuldeepp/Grainguard.git"
    error_message = "The private GreenGuard repository must use its exact GitHub SSH URL so Argo can authenticate with a repository-scoped read-only deploy key."
  }
}

variable "gitops_repository_private_key" {
  description = "Ephemeral Ed25519 read-only GitHub deploy key private material; never stored in Terraform state. Register only its public half on pahuldeepp/Grainguard."
  type        = string
  sensitive   = true
  ephemeral   = true
  default     = ""
  validation {
    condition     = var.gitops_repository_private_key == "" || can(regex("(?s)^-----BEGIN OPENSSH PRIVATE KEY-----\\n.+\\n-----END OPENSSH PRIVATE KEY-----\\n?$", var.gitops_repository_private_key))
    error_message = "gitops_repository_private_key must be a valid OpenSSH-format Ed25519 private key supplied ephemerally."
  }
}

variable "gitops_repository_key_version" {
  description = "Nonsecret monotonic counter to publish a rotated write-only GitHub deploy key version."
  type        = number
  default     = 1
  validation {
    condition     = var.gitops_repository_key_version >= 1 && floor(var.gitops_repository_key_version) == var.gitops_repository_key_version
    error_message = "gitops_repository_key_version must be a positive integer."
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

variable "clickhouse_image_digest" {
  description = "Immutable ClickHouse server OCI digest for the disposable telemetry analytics store."
  type        = string
  default     = ""
  validation {
    condition     = var.clickhouse_image_digest == "" || can(regex("^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.clickhouse_image_digest))
    error_message = "clickhouse_image_digest must be a full immutable OCI digest reference."
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

variable "enable_live_membership_acceptance" {
  description = "Run the live OIDC membership readback Job after managed Dex is deployed, the first admin is enrolled, and a short-lived access token is provisioned in Kubernetes."
  type        = bool
  default     = false
}

locals {
  deployment_contract = jsondecode(file("${path.module}/../../gitops/disposable/contract.json"))
  required_images     = toset([for release in local.deployment_contract.releases : release.image])
  required_runtime_secret_names = setunion(
    toset([for release in local.deployment_contract.releases : release.secret if release.name != "dashboard"]),
    toset(try(local.deployment_contract.operatorSecrets, [])),
    toset([for shard_id in local.postgres_shard_ids : "greenguard-${shard_id}-projection-history-maintenance-config"]),
    toset(["tenant-bootstrap-worker-config", "greenguard-telemetry-sinks-config"]),
    var.identity_mode == "managed-dex" ? toset(["greenguard-dex-config"]) : toset([])
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
  required_cell_secret_names = setunion(
    local.required_runtime_secret_names,
    local.required_bootstrap_secret_names,
    local.required_data_plane_secrets,
    local.required_migration_secret_names,
    toset(["grafana-admin"]),
  )
  managed_secret_names = setunion(
    var.secret_names,
    var.enable_application_tree ? local.required_cell_secret_names : toset([]),
  )
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
    "read-entitlement-projector"      = { service = "read-api", secret = "read-entitlement-projector", env = "SHARD_REGISTRY_FILE" }
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
  mesh_http_releases = toset(["device-service", "notification-service", "billing-service"])
  membership_verifier_releases = toset([
    "bff", "gateway", "device-service", "read-api", "workflow-alerts", "notification-service", "billing-service", "jobs-worker"
  ])
  otel_http_releases = toset([
    "device-service", "workflow-alerts", "tenant-control-plane", "telemetry-ingest",
    "cdc-transformer", "projection-builder", "cassandra-writer"
  ])
  # Only services with a reachable Prometheus /metrics endpoint use Istio's
  # merged scrape mode. Other workloads still expose Envoy metrics only.
  prometheus_application_metric_releases = toset([
    "device-service", "workflow-alerts", "telemetry-ingest", "projection-builder",
    "notification-service", "jobs-worker", "cdc-transformer", "cassandra-writer"
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
        # `oidc_dashboard_values` is null until the operator supplies the
        # existing OIDC issuer or explicitly opts into Cognito. The filter
        # below removes this value for all non-dashboard releases and when
        # OIDC is not configured; `try` must guard the attribute access itself.
        publicOidc = try(local.oidc_dashboard_values.publicOidc, null)
      } : key => value if release.name == "dashboard" && local.oidc_dashboard_values != null },
      { for key, value in {
        env = concat(local.oidc_membership_env, [
          { name = "GG_MESH_INTERNAL_HTTP", value = "1" },
          { name = "CONTROL_PLANE_MESH_MTLS", value = "true" },
          { name = "SAGA_API_URL", value = "http://saga-api-saga-orchestrator.greenguard.svc.cluster.local:8092" },
          { name = "READ_API_URL", value = "http://read-api.greenguard.svc.cluster.local:4001" },
          { name = "ALERT_API_URL", value = "http://workflow-alerts.greenguard.svc.cluster.local:3004" },
          { name = "BILLING_API_URL", value = "http://billing-service.greenguard.svc.cluster.local:3021" },
          { name = "JOBS_NOTIFICATION_API_URL", value = "http://jobs-worker.greenguard.svc.cluster.local:8095" },
          { name = "NOTIFICATION_DELIVERY_API_URL", value = "http://notification-service.greenguard.svc.cluster.local:8096" },
          { name = "KAFKA_REQUIRE_TLS", value = "true" },
          { name = "KAFKA_SECURITY_PROTOCOL", value = "SASL_SSL" },
          { name = "KAFKA_SASL_MECHANISM", value = "PLAIN" },
          { name = "KAFKA_TLS_CA_FILE", value = "/etc/greenguard/kafka/ca.crt" },
          ], var.ai_runtime_enabled ? [
          { name = "BFF_AGENT_ENABLED", value = "true" },
          { name = "BFF_AGENT_MODEL", value = "answer-v1" },
          { name = "BFF_MODEL_GATEWAY_URL", value = "http://model-gateway.greenguard.svc.cluster.local:8080" },
          { name = "BFF_MCP_API_URL", value = "http://mcp-gateway.greenguard.svc.cluster.local:8090" },
          { name = "BFF_ADVISOR_API_URL", value = "http://grain-advisor.greenguard.svc.cluster.local:8088" },
          { name = "KNOWLEDGE_API_URL", value = "http://knowledge-service.greenguard.svc.cluster.local:8080" },
          { name = "BFF_DELEGATED_ISSUER", value = local.ai_delegated_issuer },
        ] : [])
        networkPolicy = merge(try(release.baseValues.networkPolicy, {}), {
          egressServices = concat(try(release.baseValues.networkPolicy.egressServices, []), var.ai_runtime_enabled ? [
            { name = "mcp-gateway", namespace = "greenguard", release = "ai-runtime", port = 8090 },
            { name = "model-gateway", namespace = "greenguard", release = "ai-runtime", port = 8080 },
            { name = "grain-advisor", namespace = "greenguard", release = "ai-runtime", port = 8088 },
          ] : [])
        })
        envFrom             = [{ secretRef = { name = release.secret } }]
        postgresReadReplica = { caSecretName = "greenguard-rds-ca" }
        kafka               = { caSecretName = "greenguard-kafka-ca" }
      } : key => value if release.name == "bff" },
      { for key, value in {
        modelGatewayTokens = {
          enabled    = true
          secretName = "greenguard-bff-model-gateway"
          secretKey  = "gateway-tokens.json"
          filePath   = "/private-model-gateway/gateway-tokens.json"
        }
        delegationKey = {
          secretName          = "greenguard-bff-delegation"
          privateKeySecretKey = "private-key.pem"
          keyIdSecretKey      = "kid"
          filePath            = "/private-model-gateway/private-key.pem"
        }
      } : key => value if release.name == "bff" && var.ai_runtime_enabled },
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
            release.name == "billing-service" ? [
              { name = "BILLING_KAFKA_BROKERS", value = "kafka.greenguard.svc.cluster.local:29092" },
            ] : [],
            contains(toset(["audit-export-worker", "tenant-bootstrap-worker"]), release.name) ? [] : [
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
        kafka               = contains(toset(["audit-export-worker", "tenant-bootstrap-worker"]), release.name) ? { caSecretName = "" } : { caSecretName = "greenguard-kafka-ca" }
        volumes = concat(
          try(release.baseValues.volumes, []),
          release.name == "hardware-service-worker" ? [{ name = "mqtt-ca", secret = { secretName = "greenguard-mqtt-broker", items = [{ key = "ca.crt", path = "ca.crt" }] } }] : [],
          release.shardRegistry != null ? [{ name = "shard-registry", secret = { secretName = "greenguard-shard-routing-${release.shardRegistry.secret}", defaultMode = 288, items = [{ key = "registry.json", path = "registry.json" }] } }] : []
        )
      } : key => value if release.chart == "greenguard-service" },
      { for key, value in {
        networkPolicy = merge(try(release.baseValues.networkPolicy, {}), {
          ingressSources = concat(try(release.baseValues.networkPolicy.ingressSources, []),
            var.ai_runtime_enabled && release.name == "tenant-control-plane" ? [
              { namespace = "greenguard", selector = { "app.kubernetes.io/name" = "mcp-gateway", "app.kubernetes.io/instance" = "ai-runtime" } }
          ] : [])
          egressCIDRs = var.enable_application_tree ? [for cidr in data.aws_prefix_list.s3[0].cidr_blocks : { cidr = cidr, port = 443 }] : []
        })
      } : key => value if release.name == "tenant-control-plane" },
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
          mergeMetrics      = contains(local.prometheus_application_metric_releases, release.name)
          scrapePort        = contains(local.prometheus_application_metric_releases, release.name) ? 15020 : 15090
          allowedPrincipals = []
        }
      } },
      { for key, value in { networkPolicy = {
        egressCIDRs = var.enable_application_tree ? [for cidr in data.aws_prefix_list.dynamodb[0].cidr_blocks : { cidr = cidr, port = 443 }] : []
      } } : key => value if release.name == "notification-contacts-projector" },
      { for key, value in { networkPolicy = {
        egressCIDRs = var.enable_application_tree ? [for cidr in data.aws_prefix_list.s3[0].cidr_blocks : { cidr = cidr, port = 443 }] : []
      } } : key => value if release.name == "audit-export-worker" },
      { for key, value in { networkPolicy = {
        egressCIDRs = var.enable_application_tree ? [for cidr in data.aws_prefix_list.s3[0].cidr_blocks : { cidr = cidr, port = 443 }] : []
      } } : key => value if release.name == "telemetry-s3-archive" },
      { for key, value in { networkPolicy = {
        egressCIDRs = var.enable_application_tree ? [for subnet in aws_subnet.private : { cidr = subnet.cidr_block, port = 5432 }] : []
      } } : key => value if release.name == "tenant-bootstrap-worker" }
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
    edgeRouting = {
      enabled        = true
      targetGroupARN = aws_lb_target_group.mesh_ingress.arn
      accountId      = var.target_account_id
      region         = var.aws_region
    }
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
    aiRuntime = local.ai_gitops_values
    mlSynthetic = {
      enabled         = var.ml_synthetic_enabled
      imageDigest     = var.ml_synthetic_scorer_image_digest
      secretSyncEpoch = try(terraform_data.ml_synthetic_secret_sync[0].id, "")
      scopeIdentity   = "${var.target_account_id}:${var.aws_region}:${var.environment}:${var.cluster_name}:${var.cluster_name}"
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
        tenantBootstrapSecret       = "greenguard-${shard_id}-tenant-bootstrap"
        tenantBootstrapVersion      = aws_secretsmanager_secret_version.tenant_bootstrap[shard_id].version_id
        tenantBootstrapRole         = "tenant_bootstrap_${shard_id}"
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
    managedDex = {
      enabled       = var.identity_mode == "managed-dex"
      image         = var.managed_dex_image_digest
      issuer        = local.managed_dex_public.issuer
      webOrigin     = "https://${aws_cloudfront_distribution.web.domain_name}"
      databaseHost  = aws_db_instance.postgres.address
      databaseCIDRs = [for subnet in aws_subnet.private : subnet.cidr_block]
      secret        = "greenguard-dex-config"
      caSecret      = "greenguard-rds-ca"
    }
    acceptanceProbes = {
      # ClickHouse storage roundtrip can run during bootstrap. OIDC membership
      # readback needs a real, signature-verified operator access token and is
      # enabled explicitly only after interactive login/enrollment.
      enabled                 = var.identity_mode == "managed-dex"
      membershipEnabled       = var.enable_live_membership_acceptance
      clickhouseImage         = var.clickhouse_image_digest
      tenantControlPlaneImage = lookup(var.deployment_image_digests, "tenant-control-plane", "")
      membershipAudience      = local.managed_dex_public.audience
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
    clickhousePlane = {
      enabled          = true
      image            = var.clickhouse_image_digest
      storageClassName = "gp3"
      storageSize      = "20Gi"
      authSecret       = "greenguard-telemetry-clickhouse-config"
      replayS3CIDRs    = var.enable_application_tree ? [for cidr in data.aws_prefix_list.s3[0].cidr_blocks : cidr] : []
    }
  })]

  lifecycle {
    precondition {
      condition     = !var.enable_live_membership_acceptance || (var.enable_application_tree && var.identity_mode == "managed-dex")
      error_message = "Live membership acceptance requires the application tree and managed Dex; enroll the owner and provision the one-time OIDC access-token Secret before enabling it."
    }
    precondition {
      condition     = var.gitops_revision != "" && length(setsubtract(local.required_images, toset(keys(var.deployment_image_digests)))) == 0 && length(setsubtract(toset(keys(var.deployment_image_digests)), local.required_images)) == 0
      error_message = "Application tree needs an exact Git commit and one immutable digest for every and only every published image in contract.json."
    }
    precondition {
      condition     = var.clickhouse_image_digest != ""
      error_message = "Application tree needs a digest-pinned ClickHouse server image for Kafka-backed telemetry analytics."
    }
    precondition {
      condition     = length(setsubtract(local.required_cell_secret_names, local.managed_secret_names)) == 0
      error_message = "Application tree secret containers must cover its runtime, bootstrap, migration, data-plane and observability contracts."
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

  depends_on = [helm_release.parser_runtime, aws_eks_pod_identity_association.ai_knowledge, terraform_data.ai_secret_sync, helm_release.argocd, helm_release.greenguard_namespace, terraform_data.runtime_secret_sync, terraform_data.argocd_repository_secret_sync, terraform_data.argocd_repository_secret_cleanup, aws_eks_pod_identity_association.notification_contacts_projector, aws_eks_pod_identity_association.audit_export,
    terraform_data.destroy_inventory_sentinel,
    terraform_data.ml_synthetic_secret_sync,
  ]
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
      gitops_revision                  = var.gitops_revision
      deployment_image_digests         = var.deployment_image_digests
      migration_image_digests          = var.migration_image_digests
      migration_gate_image_digest      = var.migration_gate_image_digest
      migration_sql_image_digest       = var.migration_sql_image_digest
      ai_runtime_enabled               = var.ai_runtime_enabled
      ai_runtime_image_digests         = var.ai_runtime_image_digests
      ml_synthetic_enabled             = var.ml_synthetic_enabled
      ml_synthetic_scorer_image_digest = var.ml_synthetic_scorer_image_digest
      managed_dex_enabled              = var.identity_mode == "managed-dex"
      membership_acceptance_enabled    = var.enable_live_membership_acceptance
      clickhouse_image_digest          = var.clickhouse_image_digest
    }
  }
  # Helm revision changes for any root Application value update, including
  # OIDC, Secret references, shard routing and infrastructure endpoints.
  triggers_replace = helm_release.gitops_bootstrap[0].metadata.revision
  depends_on = [helm_release.gitops_bootstrap,
    terraform_data.destroy_inventory_sentinel,
  ]

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
