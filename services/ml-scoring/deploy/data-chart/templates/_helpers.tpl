{{- define "ml-synthetic-data.labels" -}}
app.kubernetes.io/name: ml-synthetic-data
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
greenguard.io/data-class: synthetic
greenguard.io/cell: {{ .Values.cell | quote }}
{{- end -}}

{{- define "ml-synthetic-data.validate" -}}
{{- if ne .Release.Namespace "ml-synthetic" }}{{ fail "synthetic data plane must be installed only in ml-synthetic" }}{{ end }}
{{- if ne .Values.namespace "ml-synthetic" }}{{ fail "namespace must remain ml-synthetic" }}{{ end }}
{{- if not (regexMatch "^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$" .Values.cell) }}{{ fail "synthetic data plane requires the exact disposable cell label" }}{{ end }}
{{- if ne .Values.secrets.postgres "ml-synthetic-postgres-auth" }}{{ fail "PostgreSQL auth Secret must use the dedicated ml-synthetic-postgres-auth" }}{{ end }}
{{- if ne .Values.secrets.postgresTls "ml-synthetic-postgres-auth" }}{{ fail "PostgreSQL TLS Secret must use the dedicated ml-synthetic-postgres-auth" }}{{ end }}
{{- if ne .Values.secrets.kafkaAuth "ml-synthetic-kafka-auth" }}{{ fail "Kafka auth Secret must use the dedicated ml-synthetic-kafka-auth" }}{{ end }}
{{- if ne .Values.secrets.kafkaTls "ml-synthetic-kafka-tls" }}{{ fail "Kafka TLS Secret must use the dedicated ml-synthetic-kafka-tls" }}{{ end }}
{{- if not (regexMatch "^([a-z0-9.-]+/)?[a-z0-9._/-]+@sha256:[a-f0-9]{64}$" .Values.images.postgres) }}{{ fail "PostgreSQL image must be pinned by immutable digest" }}{{ end }}
{{- if not (regexMatch "^[a-z0-9.-]+/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$" .Values.images.kafka) }}{{ fail "Kafka image must be pinned by immutable digest" }}{{ end }}
{{- if ne .Values.kafka.adminUser "ml_synthetic_admin" }}{{ fail "Kafka admin principal must remain ml_synthetic_admin" }}{{ end }}
{{- if ne .Values.kafka.scorerUser "ml_scoring" }}{{ fail "Kafka scorer principal must remain ml_scoring" }}{{ end }}
{{- if ne .Values.kafka.fixtureUser "ml_fixture" }}{{ fail "Kafka fixture principal must remain ml_fixture" }}{{ end }}
{{- if ne .Values.kafka.topics.input "greenguard.telemetry.recorded.v1" }}{{ fail "synthetic input topic name cannot be changed" }}{{ end }}
{{- if ne .Values.kafka.topics.shadow "greenguard.ml.prediction.shadow.v1" }}{{ fail "shadow output topic name cannot be changed" }}{{ end }}
{{- end -}}
