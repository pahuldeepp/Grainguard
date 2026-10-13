{{- define "karpenter-nodepools.validate" -}}
{{- if not (regexMatch "^[A-Za-z0-9]([A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$" (toString .Values.cell)) }}{{ fail "karpenter nodepools require the exact cell name" }}{{ end }}
{{- if not .Values.environment }}{{ fail "karpenter nodepools require environment" }}{{ end }}
{{- if has (lower (toString .Values.environment)) (list "prod" "production") }}{{ fail "karpenter nodepools chart is for a disposable cell only" }}{{ end }}
{{- if not .Values.instanceProfile }}{{ fail "karpenter nodepools require the Terraform-owned instance profile" }}{{ end }}
{{- if and (or (ne (toString .Values.pools.compute.cpuLimit) "0") (ne (toString .Values.pools.general.cpuLimit) "0")) (not (regexMatch "^al2023@v[0-9]{8}$" (toString .Values.amiAlias))) }}{{ fail "amiAlias must be a pinned al2023@vYYYYMMDD release" }}{{ end }}
{{- if lt (len .Values.zones) 2 }}{{ fail "karpenter nodepools require at least two zones" }}{{ end }}
{{- if not .Values.instanceFamilies }}{{ fail "karpenter nodepools require instanceFamilies" }}{{ end }}
{{- if ne (toString .Values.arch) "amd64" }}{{ fail "release images are linux/amd64 only" }}{{ end }}
{{- $maxCpu := 0 }}
{{- range .Values.instanceCpus }}{{ $maxCpu = max $maxCpu (int .) }}{{ end }}
{{- if ne (sortAlpha .Values.instanceCpus | join ",") "2,4" }}{{ fail "instanceCpus must be exactly 2 and 4 vCPUs for the configured quota reserve" }}{{ end }}
{{- range .Values.instanceFamilies }}{{ if not (regexMatch "^[cmr][a-z0-9]{1,6}i$" (toString .)) }}{{ fail "instanceFamilies must be standard-class Intel c/m/r families" }}{{ end }}{{ end }}
{{- if ne (sortAlpha (keys .Values.pools) | join ",") "compute,general" }}{{ fail "pools must be exactly compute and general" }}{{ end }}
{{- range $name, $pool := .Values.pools }}
{{- $limit := toString $pool.cpuLimit }}
{{- if not (regexMatch "^(0|[1-9][0-9]?)$" $limit) }}{{ fail (printf "%s cpuLimit must be a whole number of vCPUs" $name) }}{{ end }}
{{- if and (ne $limit "0") (or (lt (int $limit) 2) (gt (int $limit) 32)) }}{{ fail (printf "%s cpuLimit must be 0 or between 2 and 32" $name) }}{{ end }}
{{- end }}
{{- end -}}
