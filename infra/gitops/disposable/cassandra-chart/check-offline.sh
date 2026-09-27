#!/usr/bin/env bash
set -euo pipefail
chart="$(cd "$(dirname "$0")" && pwd)"
image='example.invalid/cassandra-writer@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
cassandra='cassandra@sha256:ee178b38a2746a8e15a115bd038ad1f864391d04a84162a018cb0dd79511709a'
base=(--set "cassandraImage=$cassandra" --set "migratorImage=$image" --set apiServerCIDR=10.100.0.1/32)
if helm template gg "$chart" "${base[@]}" >/dev/null 2>&1; then
  echo 'Cassandra rendered without auth/TLS Secret names' >&2
  exit 1
fi
if helm template gg "$chart" "${base[@]}" --set authSecret=gg-cassandra-auth >/dev/null 2>&1; then
  echo 'Cassandra rendered without TLS Secret name' >&2
  exit 1
fi
if helm template gg "$chart" "${base[@]}" --set tlsSecret=gg-cassandra-tls >/dev/null 2>&1; then
  echo 'Cassandra rendered without auth Secret name' >&2
  exit 1
fi
if helm template gg "$chart" --set "cassandraImage=$cassandra" --set "migratorImage=$image" --set authSecret=gg-cassandra-auth --set tlsSecret=gg-cassandra-tls >/dev/null 2>&1; then
  echo 'Cassandra rendered without exact API server CIDR' >&2
  exit 1
fi
rendered="$(helm template gg "$chart" "${base[@]}" --set authSecret=gg-cassandra-auth --set tlsSecret=gg-cassandra-tls)"
GG_CASSANDRA_RENDER="$rendered" ruby -ryaml -e '
  docs=YAML.load_stream(ENV.fetch("GG_CASSANDRA_RENDER"))
  find=->(kind,name){ docs.find{|d| d["kind"]==kind && d.dig("metadata","name")==name} or abort "missing #{kind} #{name}" }
  state=find.call("StatefulSet","greenguard-cassandra")
  abort "wrong replica count" unless state.dig("spec","replicas")==1
  abort "missing PVC" unless state.dig("spec","volumeClaimTemplates")&.length==1
  abort "Cassandra must run non-root" unless state.dig("spec","template","spec","securityContext","runAsNonRoot")==true
  base=find.call("NetworkPolicy","greenguard-cassandra")
  sources=base.dig("spec","ingress").flat_map{|x| x.fetch("from")}
  expected_jobs=%w[greenguard-cassandra-bootstrap greenguard-cassandra-schema greenguard-cassandra-grants greenguard-cassandra-activator]
  abort "client allowed before admin rotation" unless sources.all?{|x| x.dig("podSelector","matchLabels","greenguard.io/cassandra-job")=="true" && x.dig("podSelector","matchExpressions",0,"values")==expected_jobs}
  jobs=find.call("NetworkPolicy","greenguard-cassandra-jobs")
  abort "job egress selector too broad" unless jobs.dig("spec","podSelector","matchExpressions",0,"values")==expected_jobs
  job_ports=jobs.dig("spec","egress").flat_map{|rule| rule.fetch("ports").map{|port| port["port"]}}
  abort "jobs must have exact DNS and CQL egress" unless job_ports.sort==[53,53,9042]
  late=find.call("NetworkPolicy","greenguard-cassandra-clients")
  abort "client policy must require activated pod" unless late.dig("spec","podSelector","matchLabels","greenguard.io/cassandra-auth-ready")=="true"
  abort "new Cassandra pod must start gated" unless state.dig("spec","template","metadata","labels","greenguard.io/cassandra-auth-ready")=="false"
  activate=find.call("Job","greenguard-cassandra-activate-clients")
  abort "client activation must follow grants" unless activate.dig("metadata","annotations","argocd.argoproj.io/sync-wave")=="3" && activate.dig("metadata","annotations","argocd.argoproj.io/hook")=="PostSync"
  activate_pod=activate.dig("spec","template")
  abort "activator lacks CQL policy identity" unless activate_pod.dig("metadata","labels")=={"app"=>"greenguard-cassandra-activator","greenguard.io/cassandra-job"=>"true"}
  egress=find.call("NetworkPolicy","greenguard-cassandra-activator-api")
  abort "activator API egress too broad" unless egress.dig("spec","podSelector","matchLabels")==activate_pod.dig("metadata","labels") && egress.dig("spec","egress",0,"to",0,"ipBlock","cidr")=="10.100.0.1/32" && egress.dig("spec","egress",0,"ports",0,"port")==443
  docs.select{|d| ["StatefulSet","Job"].include?(d["kind"])}.each{|d| names=d.dig("spec","template","spec","volumes")&.map{|v| v["name"]} || []; abort "duplicate volume in #{d.dig("metadata","name")}" unless names.uniq==names}
  role=find.call("Role","greenguard-cassandra-activator")
  abort "activation RBAC too broad" unless role.dig("rules",0,"resourceNames")==["greenguard-cassandra-0"] && role.dig("rules",0,"verbs")==["get","patch"]
  {"greenguard-cassandra-role-bootstrap"=>"0", "greenguard-cassandra-grants"=>"2"}.each{|name,wave| abort "wrong #{name} wave" unless find.call("Job",name).dig("metadata","annotations","argocd.argoproj.io/sync-wave")==wave}
  schema=docs.find{|d| d["kind"]=="Job" && d.dig("metadata","name")&.start_with?("greenguard-cassandra-schema-")} or abort "missing schema Job"
  abort "schema job must precede grants" unless schema.dig("metadata","annotations","argocd.argoproj.io/sync-wave")=="1" && schema.dig("spec","activeDeadlineSeconds")==900
  abort "migration must require secure CQL" unless schema.dig("spec","template","spec","containers",0,"env").any?{|e| e["name"]=="CASSANDRA_REQUIRE_SECURE" && e["value"]=="1"}
  config=find.call("ConfigMap","greenguard-cassandra-bootstrap").fetch("data")
  abort "missing native auth/TLS config" unless config.fetch("configure.py").include?("PasswordAuthenticator") && config.fetch("configure.py").include?("optional: false") && config.fetch("configure.py").include?("PKCS12")
  abort "activation omits default-password rejection" unless config.fetch("activate.py").include?("Cassandra default superuser password is still active") && config.fetch("activate.py").include?("Cassandra rotated administrator authentication failed")
'
if helm template gg "$chart" "${base[@]}" --set authSecret=gg-cassandra-auth --set tlsSecret=gg-cassandra-tls --set cassandraImage='cassandra:5' >/dev/null 2>&1; then
  echo 'Cassandra accepted mutable image tag' >&2
  exit 1
fi
if helm template gg "$chart" "${base[@]}" --set authSecret=gg-cassandra-auth --set tlsSecret=gg-cassandra-tls --set apiServerCIDR=0.0.0.0/0 >/dev/null 2>&1; then
  echo 'Cassandra accepted broad API egress' >&2
  exit 1
fi
echo 'Cassandra offline gate: fail-closed Secrets, native auth/TLS config, ordered bootstrap and pinned images pass'
