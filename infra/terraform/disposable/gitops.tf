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

locals {
  deployment_contract = jsondecode(file("${path.module}/../../gitops/disposable/contract.json"))
  required_images     = toset([for release in local.deployment_contract.releases : release.image])
  required_runtime_secret_names = toset([
    for release in local.deployment_contract.releases : release.secret if release.name != "dashboard"
  ])
  required_bootstrap_secret_names = toset(["greenguard-rds-bootstrap", "greenguard-rds-ca"])
  required_observability_images   = toset(["otel-collector", "prometheus", "grafana", "tempo", "loki"])
  required_data_plane_images      = toset(["pgbouncer", "kafka-topics", "kafka-connect", "connector-registration"])
  required_data_plane_secrets     = toset(["greenguard-pgbouncer-auth", "greenguard-cdc-credentials", "greenguard-kafka-auth", "greenguard-kafka-ca", "greenguard-kafka-connect-auth", "greenguard-kafka-admin-auth", "greenguard-opensearch-admin", "greenguard-opensearch-clients", "greenguard-opensearch-tls", "greenguard-opensearch-ca", "greenguard-cassandra-auth", "greenguard-cassandra-tls"])
  # These are public OIDC identifiers, never credentials. Sensitive runtime
  # inputs (database URLs, CONTROL_LOOKUP_TOKEN, broker credentials, etc.)
  # remain in the per-release Kubernetes Secret named by contract.json.
  cognito_verifier_env = [
    { name = "AUTH_TOKEN_MODE", value = "cognito-access" },
    { name = "AUTH_ISSUER", value = local.cognito_issuer },
    { name = "AUTH_JWKS_URL", value = "${local.cognito_issuer}/.well-known/jwks.json" },
    { name = "AUTH_COGNITO_CLIENT_IDS", value = join(",", [aws_cognito_user_pool_client.web.id, aws_cognito_user_pool_client.mobile.id]) },
    # Explicitly clear any legacy audience inherited from a Secret. Cognito
    # access tokens without resource binding have no aud claim.
    { name = "AUTH_AUDIENCE", value = "" },
  ]
  cognito_membership_env = concat(local.cognito_verifier_env, [
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
  application_releases = [for release in local.deployment_contract.releases : {
    name        = release.name
    chart       = release.chart
    profile     = try(release.profile, null)
    imageDigest = lookup(var.deployment_image_digests, release.image, "")
    extraValues = merge(
      { for key, value in {
        publicOidc = {
          enabled        = true
          authority      = local.cognito_issuer
          clientId       = aws_cognito_user_pool_client.web.id
          tokenMode      = "cognito-access"
          audience       = ""
          resource       = ""
          connectOrigins = [local.cognito_login]
        }
      } : key => value if release.name == "dashboard" },
      { for key, value in {
        env = concat(local.cognito_membership_env, [
          { name = "KAFKA_REQUIRE_TLS", value = "true" },
          { name = "KAFKA_SECURITY_PROTOCOL", value = "SASL_SSL" },
          { name = "KAFKA_SASL_MECHANISM", value = "PLAIN" },
          { name = "KAFKA_TLS_CA_FILE", value = "/etc/greenguard/kafka/ca.crt" },
        ])
        envFrom = [{ secretRef = { name = release.secret } }]
        kafka   = { caSecretName = "greenguard-kafka-ca" }
      } : key => value if release.name == "bff" },
      { for key, value in {
        container = merge(
          { envFrom = [{ secretRef = { name = release.secret } }] },
          { env = concat(
            contains(local.membership_verifier_releases, release.name) ? local.cognito_membership_env : release.name == "tenant-control-plane" ? local.cognito_verifier_env : [],
            contains(local.otel_http_releases, release.name) ? local.otel_http_env : [],
            contains(local.mesh_http_releases, release.name) ? [{ name = "GG_MESH_INTERNAL_HTTP", value = "1" }] : [],
            [
              { name = "KAFKA_REQUIRE_TLS", value = "true" },
              { name = "KAFKA_SECURITY_PROTOCOL", value = "SASL_SSL" },
              { name = "KAFKA_SASL_MECHANISM", value = "PLAIN" },
              { name = "KAFKA_TLS_CA_FILE", value = "/etc/greenguard/kafka/ca.crt" },
            ]
          ) }
        )
        kafka = { caSecretName = "greenguard-kafka-ca" }
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
      } }
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
    cell                = var.cluster_name
    repositoryUrl       = var.gitops_repository_url
    revision            = var.gitops_revision
    releases            = local.application_releases
    observabilityImages = var.observability_image_digests
    dataPlane = {
      enabled = true
      rdsHost = aws_db_instance.postgres.address
      images  = var.data_plane_image_digests
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
  })]

  lifecycle {
    precondition {
      condition     = var.gitops_revision != "" && length(setsubtract(local.required_images, toset(keys(var.deployment_image_digests)))) == 0 && length(setsubtract(toset(keys(var.deployment_image_digests)), local.required_images)) == 0
      error_message = "Application tree needs an exact Git commit and one immutable digest for every and only every published image in contract.json."
    }
    precondition {
      condition     = length(setsubtract(setunion(local.required_runtime_secret_names, local.required_bootstrap_secret_names, local.required_data_plane_secrets, toset(["grafana-admin"])), var.secret_names)) == 0
      error_message = "Application tree needs Secrets Manager containers for runtime, bootstrap, data-plane credentials and grafana-admin; populate and materialize values out of band before deployment."
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
  }

  depends_on = [helm_release.argocd]
}
