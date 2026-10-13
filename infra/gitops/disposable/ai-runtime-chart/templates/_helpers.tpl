{{- define "ai.validate" -}}
{{- if ne .Release.Namespace "greenguard" }}{{ fail "AI runtimes require greenguard namespace" }}{{ end -}}
{{- if not (regexMatch "^[A-Za-z0-9]([A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$" .Values.cell) }}{{ fail "exact disposable cell label required" }}{{ end -}}
{{- if or (not .Values.environment) (has (lower .Values.environment) (list "prod" "production")) }}{{ fail "AI runtimes require explicit non-production environment" }}{{ end -}}
{{- if not (regexMatch "^[a-f0-9]{40}$" .Values.revision) }}{{ fail "exact Git revision required" }}{{ end -}}
{{- if not .Values.secretSyncEpoch }}{{ fail "exact cell Secret synchronization must finish first" }}{{ end -}}
{{- if not (regexMatch "^[0-9]{12}:[a-z]{2}(-[a-z]+)+-[0-9]+:[a-z][a-z0-9-]{1,15}:[A-Za-z0-9][A-Za-z0-9_-]{0,99}:[A-Za-z0-9][A-Za-z0-9_-]{0,99}$" .Values.scopeIdentity) }}{{ fail "exact Terraform AWS scope identity required" }}{{ end -}}
{{- $scope := splitList ":" .Values.scopeIdentity -}}
{{- if or (ne .Values.environment (index $scope 2)) (ne .Values.cell (index $scope 4)) }}{{ fail "AI environment/cell must match exact Terraform scope" }}{{ end -}}
{{- if not (regexMatch "^[A-Za-z0-9.-]+\\.rds\\.amazonaws\\.com$" .Values.rdsHost) }}{{ fail "exact central RDS host required" }}{{ end -}}
{{- $repositories := dict "knowledge" "knowledge-service" "indexer" "knowledge-indexer" "parser" "knowledge-parser" "advisor" "grain-advisor" "gateway" "model-gateway" "usage" "model-gateway-usage" "mcp" "mcp-gateway" -}}
{{- range $key := list "knowledge" "indexer" "parser" "advisor" "gateway" "usage" "mcp" -}}
{{- $repository := index $repositories $key -}}
{{- $ghcr := printf "^ghcr\\.io/pahuldeepp/grainguard/%s@sha256:[a-f0-9]{64}$" $repository -}}
{{- $ecr := printf "^%s\\.dkr\\.ecr\\.%s\\.amazonaws\\.com/greenguard/%s/cell-%s/%s@sha256:[a-f0-9]{64}$" (index $scope 0) (index $scope 1) (index $scope 2) (trunc 16 (sha256sum (index $scope 4))) $repository -}}
{{- if not (or (regexMatch $ghcr (index $.Values.images $key)) (regexMatch $ecr (index $.Values.images $key))) }}{{ fail (printf "approved immutable %s GHCR or exact-cell ECR image required" $key) }}{{ end -}}
{{- end -}}
{{- if not (regexMatch "^https://[A-Za-z0-9.-]+(:443)?/?$" .Values.providers.pineconeIndexHost) }}{{ fail "Pinecone index requires a bare HTTPS host" }}{{ end -}}
{{- if ne .Values.providers.kafkaBootstrapServers "kafka.greenguard.svc.cluster.local:29092" }}{{ fail "AI Kafka must use the exact approved cell TLS endpoint" }}{{ end -}}
{{- if ne .Values.images.redis "redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499" }}{{ fail "Redis must use the reviewed pinned TLS-capable image" }}{{ end -}}
{{- if not (regexMatch "^(docker\\.io/)?clamav/clamav@sha256:[a-f0-9]{64}$" .Values.images.clamav) }}{{ fail "official immutable ClamAV image required" }}{{ end -}}
{{- if ne .Values.providers.clamavHost "clamav.greenguard.svc.cluster.local" }}{{ fail "owned exact cell ClamAV DNS required" }}{{ end -}}
{{- range $key := list "authIssuer" "authJwksUrl" "delegatedIssuer" "delegatedJwksUrl" "pineconeIndexHost" "voyageUrl" "anthropicUrl" -}}
{{- if not (regexMatch "^https://[A-Za-z0-9.-]+(:443)?(/[^[:space:]?#]*)?$" (index $.Values.providers $key)) }}{{ fail (printf "%s requires HTTPS without credentials/query/fragment" $key) }}{{ end -}}
{{- end -}}
{{- range $key := list "embeddingModel" "rerankerModel" "answerModel" "s3Bucket" "s3Region" "s3KmsKeyArn" "kafkaBootstrapServers" "clamavHost" -}}
{{- if not (index $.Values.providers $key) }}{{ fail (printf "provider input %s required" $key) }}{{ end -}}
{{- end -}}
{{- if eq .Values.providers.authTokenMode "audience" -}}
{{- if or (not .Values.providers.authAudience) (gt (len .Values.providers.authClientIds) 0) }}{{ fail "audience OIDC mode requires an audience and no client-ID allowlist" }}{{ end -}}
{{- else if eq .Values.providers.authTokenMode "cognito-access" -}}
{{- if or .Values.providers.authAudience (eq (len .Values.providers.authClientIds) 0) (gt (len .Values.providers.authClientIds) 16) }}{{ fail "Cognito access-token mode requires exact client IDs and no audience" }}{{ end -}}
{{- else -}}{{ fail "authTokenMode must be audience or cognito-access" }}{{- end -}}
{{- range $key := list "rdsCIDRs" "externalHTTPSCIDRs" "kubernetesAPICIDRs" -}}
{{- if not (index $.Values $key) }}{{ fail (printf "explicit bounded %s required" $key) }}{{ end -}}
{{- range $cidr := index $.Values $key -}}
{{- if not (regexMatch "^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])/(8|9|[12][0-9]|3[0-2])$" $cidr) }}{{ fail "bounded IPv4 CIDRs (/8 through /32) required" }}{{ end -}}
{{- end -}}{{- end -}}
{{- if ne .Values.parserRuntimeClassName "greenguard-parser-runsc" }}{{ fail "exact owned greenguard-parser-runsc RuntimeClass required" }}{{ end -}}
{{- if not .Values.podIdentityAssociationsReady }}{{ fail "scoped knowledge-api and knowledge-indexer cloud identity associations must be ready" }}{{ end -}}
{{- range $role := list .Values.knowledgeAPIRoleArn .Values.knowledgeIndexerRoleArn }}
{{- if not (regexMatch "^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$" $role) }}{{ fail "distinct scoped S3/KMS pod identity roles required" }}{{ end -}}
{{- end }}
{{- if eq .Values.knowledgeAPIRoleArn .Values.knowledgeIndexerRoleArn }}{{ fail "Knowledge API and indexer require separate IAM roles" }}{{ end -}}
{{- end -}}

{{- define "ai.security" -}}
runAsNonRoot: true
runAsUser: 10001
runAsGroup: 10001
fsGroup: 10001
seccompProfile: {type: RuntimeDefault}
{{- end -}}
{{- define "ai.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities: {drop: [ALL]}
{{- end -}}
