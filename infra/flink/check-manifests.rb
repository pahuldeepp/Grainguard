#!/usr/bin/env ruby
# Static guards for the optional Flink deployment (ADR-0030): it must stay disabled by default,
# loopback-only and unreferenced by every default stack. Exit 1 on the first violation.
require "yaml"

ROOT = File.expand_path("../..", __dir__)
failures = []
check = ->(ok, message) { failures << message unless ok }

compose = YAML.load_file(File.join(ROOT, "infra/flink/compose.yaml"), aliases: true)
services = compose.fetch("services")
check.(services.keys.sort == %w[flink-jobmanager flink-taskmanager], "compose.yaml must define only the two Flink services")
services.each do |name, svc|
  check.(Array(svc["profiles"]) == ["flink"], "#{name} must be in the flink profile only")
  check.(Array(svc["cap_drop"]) == ["ALL"], "#{name} must drop all capabilities")
  check.(Array(svc["security_opt"]).include?("no-new-privileges:true"), "#{name} must set no-new-privileges")
  Array(svc["ports"]).each { |port| check.(port.to_s.start_with?("127.0.0.1:"), "#{name} publishes #{port} beyond loopback") }
end

deployment = YAML.load_file(File.join(ROOT, "infra/flink/k8s/flinkdeployment.yaml"))
check.(deployment.dig("spec", "job", "state") == "suspended", "FlinkDeployment must default to job.state: suspended")
check.(deployment.dig("spec", "image").to_s.include?("@sha256:"), "FlinkDeployment image must be pinned by digest")
check.(deployment.dig("spec", "image").to_s.include?("REPLACE_WITH_DIGEST"), "FlinkDeployment must ship a placeholder digest (fail closed)")
check.(deployment.dig("spec", "job", "upgradeMode") == "last-state", "upgradeMode must be last-state")
check.(deployment.dig("spec", "flinkConfiguration", "high-availability.type") == "kubernetes", "HA must be enabled")

# Nothing else may reference the optional deployment.
referrers = `grep -rIl --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.claude --exclude-dir=evidence --exclude-dir=.omc --exclude-dir=.serena --exclude-dir=coverage --exclude-dir=build -e 'infra/flink' #{ROOT}`
  .split("\n").map { |f| f.sub("#{ROOT}/", "") }
allowed = %w[Makefile docs/adr/0030-flink-optional-stream-processing.md services/stream-processor/README.md services/stream-processor/Dockerfile
             scripts/flink-e2e.mjs scripts/flink-bench.mjs scripts/flink-risk-ci.mjs .github/workflows/flink-risk.yml infra/flink/check-manifests.rb infra/flink/README.md docs/TECHNOLOGY_CATALOG.md
             infra/flink/k8s/kustomization.yaml infra/flink/restore.sh infra/flink/topics.sh infra/flink/compose.yaml infra/flink/compose.standalone.yaml]
unexpected = referrers.reject { |f| allowed.include?(f) || f.start_with?("infra/flink/") }
check.(unexpected.empty?, "unexpected references to infra/flink: #{unexpected.join(', ')}")
%w[infra/gitops infra/helm infra/compose infra/kafka].each do |dir|
  hit = `grep -rIl -e 'infra/flink' -e 'flink-jobmanager' #{File.join(ROOT, dir)} 2>/dev/null`.strip
  check.(hit.empty?, "#{dir} must not reference the Flink deployment (#{hit})")
end

if failures.empty?
  puts "flink manifests: ok (disabled by default, loopback only, unreferenced)"
else
  warn failures.map { |f| "FAIL: #{f}" }
  exit 1
end
