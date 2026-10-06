{{- define "ai.knowledgeEnv" -}}
- {name: KNOWLEDGE_LISTEN_HOST, value: "0.0.0.0"}
- {name: KNOWLEDGE_LISTEN_PORT, value: "8080"}
- {name: KNOWLEDGE_MEMBERSHIP_SOURCE, value: "control-plane"}
- {name: KNOWLEDGE_ENVIRONMENT, value: "disposable-aws"}
- {name: CONTROL_PLANE_URL, value: "http://tenant-control-plane.greenguard.svc.cluster.local:3010"}
- {name: CONTROL_PLANE_MESH_MTLS, value: "true"}
- {name: KNOWLEDGE_MODEL_GATEWAY_URL, value: "http://model-gateway.greenguard.svc.cluster.local:8080"}
- {name: KNOWLEDGE_MODEL_GATEWAY_MESH_MTLS, value: "true"}
- {name: KNOWLEDGE_MODEL_GATEWAY_TOKENS_FILE, value: "/private/gateway-tokens.json"}
- {name: KNOWLEDGE_RELAY_TENANTS_FILE, value: "/private/relay-tenants.json"}
- {name: KNOWLEDGE_RETENTION_SCOPES_FILE, value: "/private/retention-scopes.json"}
- {name: PINECONE_API_KEY_FILE, value: "/private/pinecone-api-key"}
- {name: KNOWLEDGE_REDIS_URL_FILE, value: "/private/redis-url"}
- {name: KNOWLEDGE_REDIS_CA_FILE, value: "/redis-ca/ca.pem"}
- {name: AUTH_ISSUER, value: {{ .Values.providers.authIssuer | quote }}}
- {name: AUTH_AUDIENCE, value: {{ .Values.providers.authAudience | quote }}}
- {name: AUTH_TOKEN_MODE, value: {{ .Values.providers.authTokenMode | quote }}}
- name: AUTH_CLIENT_IDS
  value: {{ join "," .Values.providers.authClientIds | quote }}
- {name: AUTH_JWKS_URL, value: {{ .Values.providers.authJwksUrl | quote }}}
- {name: DELEGATED_ISSUER, value: {{ .Values.providers.delegatedIssuer | quote }}}
- {name: DELEGATED_JWKS_URL, value: {{ .Values.providers.delegatedJwksUrl | quote }}}
{{- range $entry := list (list "KNOWLEDGE_S3_BUCKET" "s3Bucket") (list "KNOWLEDGE_S3_REGION" "s3Region") (list "KNOWLEDGE_S3_KMS_KEY_ID" "s3KmsKeyArn") (list "PINECONE_INDEX_HOST" "pineconeIndexHost") (list "KNOWLEDGE_EMBEDDING_MODEL" "embeddingModel") (list "KNOWLEDGE_RERANKER_MODEL" "rerankerModel") (list "KNOWLEDGE_ANSWER_MODEL" "answerModel") (list "KNOWLEDGE_KAFKA_BOOTSTRAP_SERVERS" "kafkaBootstrapServers") (list "KNOWLEDGE_CLAMAV_HOST" "clamavHost") }}
- {name: {{ index $entry 0 }}, value: {{ index $.Values.providers (index $entry 1) | quote }}}
{{- end }}
- {name: KNOWLEDGE_PARSER_BACKEND, value: "kubernetes"}
- {name: KNOWLEDGE_PARSER_IMAGE, value: {{ .Values.images.parser | quote }}}
- {name: KNOWLEDGE_KAFKA_SECURITY_PROTOCOL, value: "SASL_SSL"}
- {name: KNOWLEDGE_KAFKA_SASL_MECHANISM, value: "PLAIN"}
- {name: KNOWLEDGE_KAFKA_CA_FILE, value: "/kafka-ca/ca.pem"}
{{- range $entry := list (list "KNOWLEDGE_DATABASE_URL" "database-url") (list "CONTROL_LOOKUP_TOKEN" "control-lookup-token") (list "KNOWLEDGE_NAMESPACE_HMAC_KEY" "namespace-hmac-key") (list "KNOWLEDGE_KAFKA_SASL_USERNAME" "kafka-username") (list "KNOWLEDGE_KAFKA_SASL_PASSWORD" "kafka-password") }}
{{- $key := index $entry 1 }}
{{- if or (eq $key "database-url") (and (eq $key "control-lookup-token") (has $.profile (list "knowledge-service" "knowledge-summary"))) (and (eq $key "namespace-hmac-key") (has $.profile (list "knowledge-service" "knowledge-indexer"))) (and (has $key (list "kafka-username" "kafka-password")) (has $.profile (list "knowledge-indexer" "knowledge-relay" "knowledge-analytics" "knowledge-retention"))) }}
- name: {{ index $entry 0 }}
  valueFrom: {secretKeyRef: {name: {{ if eq (index $entry 1) "database-url" }}{{ $.databaseSecret | default "greenguard-knowledge-runtime" }}{{ else }}greenguard-knowledge-runtime{{ end }}, key: {{ index $entry 1 }}}}
{{- end }}
{{- end }}
{{- end -}}

{{- define "ai.advisorEnv" -}}
- {name: ADVISOR_HTTP_HOST, value: "0.0.0.0"}
- {name: ADVISOR_OWNER_MESH_MTLS, value: "true"}
- {name: ADVISOR_HTTP_PORT, value: "8088"}
- {name: ADVISOR_DELEGATED_ISSUER, value: {{ .Values.providers.delegatedIssuer | quote }}}
- {name: ADVISOR_DELEGATED_JWKS_URL, value: {{ .Values.providers.delegatedJwksUrl | quote }}}
- {name: CONTROL_PLANE_MEMBERSHIP_URL, value: "http://tenant-control-plane.greenguard.svc.cluster.local:3010"}
- {name: ADVISOR_ALERTS_ORIGIN, value: "http://workflow-alerts.greenguard.svc.cluster.local:3004"}
{{- range $entry := list (list "ADVISOR_DATABASE_URL" "database-url") (list "CONTROL_PLANE_MEMBERSHIP_SERVICE_TOKEN" "membership-service-token") (list "ADVISOR_ALERTS_SERVICE_TOKEN" "alerts-service-token") }}
- name: {{ index $entry 0 }}
  valueFrom: {secretKeyRef: {name: greenguard-advisor-runtime, key: {{ index $entry 1 }}}}
{{- end }}
{{- end -}}

{{- define "ai.gatewayEnv" -}}
- {name: MODEL_GATEWAY_LISTEN_ADDR, value: ":8080"}
- {name: MODEL_GATEWAY_ACCESS_FILE, value: "/private/access.json"}
- {name: MODEL_GATEWAY_CONTROLS_FILE, value: "/private/controls.json"}
- {name: MODEL_GATEWAY_REDIS_URL_FILE, value: "/private/redis-url"}
- {name: MODEL_GATEWAY_REDIS_CA_FILE, value: "/redis-ca/ca.pem"}
- {name: MODEL_GATEWAY_BUDGET_DSN_FILE, value: "/private/budget-dsn"}
- {name: MODEL_GATEWAY_VOYAGE_KEY_FILE, value: "/private/voyage-key"}
- {name: MODEL_GATEWAY_ANTHROPIC_KEY_FILE, value: "/private/anthropic-key"}
- {name: MODEL_GATEWAY_VOYAGE_URL, value: {{ .Values.providers.voyageUrl | quote }}}
- {name: MODEL_GATEWAY_ANTHROPIC_URL, value: {{ .Values.providers.anthropicUrl | quote }}}
{{- end -}}

{{- define "ai.mcpEnv" -}}
- {name: MCP_HOST, value: "0.0.0.0"}
- {name: MCP_PORT, value: "8090"}
- {name: MCP_DELEGATED_ISSUER, value: {{ .Values.providers.delegatedIssuer | quote }}}
- {name: MCP_DELEGATED_JWKS_URL, value: {{ .Values.providers.delegatedJwksUrl | quote }}}
- {name: MCP_MESH_INTERNAL_HTTP, value: "true"}
- {name: CONTROL_PLANE_URL, value: "http://tenant-control-plane.greenguard.svc.cluster.local:3010"}
- {name: MCP_KNOWLEDGE_URL, value: "http://knowledge-service.greenguard.svc.cluster.local:8080"}
- {name: MCP_READ_API_URL, value: "http://read-api.greenguard.svc.cluster.local:4001"}
- {name: MCP_ALERTS_URL, value: "http://workflow-alerts.greenguard.svc.cluster.local:3004"}
- {name: MCP_ADVISOR_URL, value: "http://grain-advisor.greenguard.svc.cluster.local:8088"}
- name: CONTROL_LOOKUP_TOKEN
  valueFrom: {secretKeyRef: {name: tenant-control-plane-config, key: CONTROL_LOOKUP_TOKEN}}
{{- end -}}
