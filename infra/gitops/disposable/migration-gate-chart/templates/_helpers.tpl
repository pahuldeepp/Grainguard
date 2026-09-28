{{- define "ownerMigration.targets" -}}
{{- $v := . -}}
{{- if not (regexMatch "^[a-f0-9]{40}$" ($v.revision | default "")) }}{{ fail "migration revision must be an exact commit" }}{{ end }}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" ($v.caSecret | default "")) }}{{ fail "migration CA Secret required" }}{{ end }}
{{- $inventory := (fromJsonArray `[{"name":"control","database":"greenguard_control","key":"CONTROL_MIGRATION_URL","table":"organizations","role":"control_app","migrator":"control_migrator","central":true,"node":true,"python":false},{"name":"billing","database":"greenguard_billing","key":"BILLING_MIGRATION_URL","table":"billing_audit_events","role":"billing_app","migrator":"billing_migrator","central":true,"node":true,"python":false},{"name":"telemetry","database":"greenguard_telemetry","key":"TELEMETRY_MIGRATION_URL","table":"readings","role":"telemetry_app","migrator":"telemetry_migrator","central":false,"node":false,"python":false},{"name":"projection","database":"greenguard_read","key":"PROJECTION_MIGRATION_URL","table":"device_views","role":"projection_app","migrator":"projection_migrator","central":false,"node":false,"python":false},{"name":"jobs","database":"greenguard_jobs","key":"JOBS_MIGRATION_URL","table":"notification_intents","role":"jobs_app","migrator":"jobs_migrator","central":false,"node":false,"python":false},{"name":"saga","database":"greenguard_sagas","key":"SAGA_MIGRATION_URL","table":"provisioning_sagas","role":"saga_app","migrator":"saga_migrator","central":false,"node":false,"python":false},{"name":"hardware","database":"greenguard_hardware","key":"HARDWARE_MIGRATION_URL","table":"hardware_assets","role":"hardware_app","migrator":"hardware_migrator","central":false,"node":false,"python":false},{"name":"inventory","database":"greenguard_inventory","key":"INVENTORY_MIGRATION_URL","table":"devices","role":"inventory_app","migrator":"inventory_migrator","central":false,"node":true,"python":false},{"name":"alerts","database":"greenguard_alerts","key":"ALERTS_MIGRATION_URL","table":"alert_episodes","role":"alerts_app","migrator":"alerts_migrator","central":false,"node":true,"python":false},{"name":"risk","database":"greenguard_risk","key":"RISK_MIGRATION_URL","table":"risk_assessments","role":"risk_app","migrator":"risk_migrator","central":false,"node":false,"python":true},{"name":"notifications","database":"greenguard_notifications","key":"NOTIFICATIONS_MIGRATION_URL","table":"deliveries","role":"notifications_app","migrator":"notifications_migrator","central":false,"node":true,"python":false}]`) -}}
{{- if ne (len ($v.images | default dict)) 11 }}{{ fail "exactly eleven migration images required" }}{{ end }}
{{- if ne (len ($v.scopes | default dict)) 5 }}{{ fail "central and four migration scopes required" }}{{ end }}
{{- if not (and (kindIs "slice" $v.rdsCIDRs) (gt (len $v.rdsCIDRs) 0) (le (len $v.rdsCIDRs) 6)) }}{{ fail "migration private RDS CIDRs required" }}{{ end }}
{{- range $v.rdsCIDRs -}}
{{- if not (regexMatch "^(10\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}|172\\.(1[6-9]|2[0-9]|3[01])\\.[0-9]{1,3}\\.[0-9]{1,3}|192\\.168\\.[0-9]{1,3}\\.[0-9]{1,3})/(1[6-9]|2[0-9]|3[0-2])$" .) }}{{ fail "migration RDS CIDR must be bounded private IPv4" }}{{ end }}
{{- range (splitList "." (index (splitList "/" .) 0)) }}{{ if gt (int .) 255 }}{{ fail "invalid migration IPv4 octet" }}{{ end }}{{ end }}
{{- end -}}
{{- if not (regexMatch "^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}/32$" ($v.apiServerCIDR | default "")) }}{{ fail "migration gate API server /32 required" }}{{ end }}
{{- range (splitList "." (index (splitList "/" $v.apiServerCIDR) 0)) }}{{ if gt (int .) 255 }}{{ fail "invalid API IPv4 octet" }}{{ end }}{{ end }}
{{- $targets := list -}}
{{- $hosts := dict -}}
{{- range $scope := list "central" "s1" "s2" "s3" "s4" -}}
{{- $config := index $v.scopes $scope | default dict -}}
{{- $host := $config.rdsHost | default "" -}}
{{- if not (regexMatch "^[a-zA-Z0-9.-]+\\.rds\\.amazonaws\\.com$" $host) }}{{ fail "each migration scope requires RDS hostname" }}{{ end }}
{{- if hasKey $hosts (lower $host) }}{{ fail "migration scope RDS hosts must be distinct" }}{{ end }}
{{- $_ := set $hosts (lower $host) true -}}
{{- if ne (len ($config.secrets | default dict)) (int (ternary 2 9 (eq $scope "central"))) }}{{ fail "migration scope owner Secret inventory mismatch" }}{{ end }}
{{- range $owner := $inventory -}}
{{- if eq $owner.central (eq $scope "central") -}}
{{- $image := index $v.images $owner.name | default "" -}}
{{- if not (regexMatch "^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$" $image) }}{{ fail "immutable migration image required" }}{{ end }}
{{- $secret := index $config.secrets $owner.name | default "" -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" $secret) }}{{ fail "owner migration Secret required" }}{{ end }}
{{- $behavior := dict "revision" $v.revision "image" $image "host" $host "secret" $secret "caSecret" $v.caSecret "sqlImage" ($v.sqlImage | default "") "gateImage" ($v.gateImage | default "") "rdsCIDRs" $v.rdsCIDRs "apiServerCIDR" $v.apiServerCIDR "owner" $owner -}}
{{- $job := printf "gg-%s-%s-migrate-%s" $scope $owner.name (sha256sum (toJson $behavior) | trunc 12) -}}
{{- $targets = append $targets (merge (dict "scope" $scope "image" $image "secret" $secret "host" $host "job" $job) $owner) -}}
{{- end -}}{{- end -}}{{- end -}}
{{- toYaml $targets -}}
{{- end -}}

{{- define "ownerMigration.uriCheck" -}}
# Validate credentials without printing their URI. Each owner is
# bound to its exact migration role, database and owning RDS host.
case "$MIGRATION_URL" in
  postgresql://{{ .migrator }}:*@{{ .host }}:5432/{{ .database }}\?*|postgres://{{ .migrator }}:*@{{ .host }}:5432/{{ .database }}\?*) ;;
  *) echo 'migration gate URI identity mismatch' >&2; exit 1;;
esac
query="${MIGRATION_URL#*\?}"; tls=0; ca=0
IFS='&' read -ra parameters <<< "$query"
for parameter in "${parameters[@]}"; do
  case "$parameter" in
    sslmode=verify-full) tls=$((tls+1));;
    sslrootcert=/rds-ca/ca.pem|sslrootcert=%2Frds-ca%2Fca.pem|sslrootcert=%2frds-ca%2fca.pem) ca=$((ca+1));;
    application_name=*|connect_timeout=[1-9]|connect_timeout=10) ;;
    *) echo 'migration gate rejected URI options' >&2; exit 1;;
  esac
done
test "$tls" = 1 && test "$ca" = 1
{{- end -}}
