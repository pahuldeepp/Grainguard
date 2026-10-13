{{- define "ml-scoring.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ml-scoring.labels" -}}
app.kubernetes.io/name: {{ include "ml-scoring.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- if eq .Values.environment "cluster-synthetic" }}
greenguard.io/cell: {{ required "cell is required in cluster-synthetic mode" .Values.cell | quote }}
{{- end }}
{{- end -}}

{{- define "ml-scoring.image" -}}
{{- $repository := required "image.repository is required" .Values.image.repository -}}
{{- if contains "@" $repository -}}{{- fail "image.repository must not contain a digest; set image.digest" -}}{{- end -}}
{{- $digest := default "" .Values.image.digest -}}
{{- if $digest -}}
  {{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) -}}{{- fail "image.digest must be sha256 followed by 64 lowercase hexadecimal characters" -}}{{- end -}}
  {{- printf "%s@%s" $repository $digest -}}
{{- else -}}
  {{- if not .Values.image.allowTagFallback -}}{{- fail "image.digest is required unless image.allowTagFallback is explicitly enabled for local synthetic testing" -}}{{- end -}}
  {{- printf "%s:%s" $repository (required "image.tag is required when image.digest is empty" .Values.image.tag) -}}
{{- end -}}
{{- end -}}
