#!/usr/bin/env ruby
# Assemble only digests signed and verified by the publish matrix. Produces a
# reviewable Terraform input artifact; this script never applies it to AWS.
require 'json'
require 'fileutils'

abort 'usage: assemble-ci-digests.rb RUNTIME_ARTIFACT_DIRECTORY MIGRATION_ARTIFACT_DIRECTORY PLATFORM_ARTIFACT_DIRECTORY COMMIT_SHA OUTPUT_DIRECTORY' unless ARGV.length == 5
artifact_dir, migration_artifact_dir, platform_artifact_dir, revision, output_dir = ARGV
abort 'revision must be a full Git commit SHA' unless revision.match?(/\A[a-f0-9]{40}\z/)
abort 'output directory already exists' if File.exist?(output_dir)
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
names = contract.fetch('releases').map { |release| release.fetch('image') }.uniq.sort
files = Dir.glob(File.join(artifact_dir, '*.json')).sort
synthetic_file = files.find { |file| File.basename(file, '.json') == 'ml-scoring-synthetic' }
platform_inventory = JSON.parse(File.read(File.join(__dir__, 'platform-image-inventory.json')))
ai_inventory = platform_inventory.fetch('ai_runtime_images')
ai_repository_names = ai_inventory.select { |entry| entry.fetch('status') == 'source_present' }.map { |entry| entry.fetch('name') }.sort
ai_missing_sources = ai_inventory.select { |entry| entry.fetch('status') == 'blocked_missing_source' }
abort 'AI inventory contains an unrecognized source status' unless ai_inventory.all? { |entry| %w[source_present blocked_missing_source].include?(entry.fetch('status')) }
ai_missing_sources.each do |entry|
  abort "#{entry.fetch('name')}: source is marked missing but Dockerfile exists" if File.file?(entry.fetch('expectedDockerfile'))
end
ai_inventory.select { |entry| entry.fetch('status') == 'source_present' }.each do |entry|
  abort "#{entry.fetch('name')}: source is marked present but Dockerfile is missing" unless File.file?(entry.fetch('dockerfile'))
end
ai_files = files.select { |file| ai_repository_names.include?(File.basename(file, '.json')) }
runtime_files = files.reject { |file| file == synthetic_file || ai_files.include?(file) }
expected_artifacts = (names + ai_repository_names + ['ml-scoring-synthetic']).sort
abort 'runtime/AI digest artifact inventory mismatch' unless files.map { |file| File.basename(file, '.json') }.sort == expected_artifacts

def verified_artifacts(files, revision, source_repositories:, keys_by_repository:, description:)
  expected_repositories = source_repositories.sort
  actual_repositories = files.map { |file| File.basename(file, '.json') }.sort
  abort "#{description} digest artifact inventory mismatch" unless actual_repositories == expected_repositories

  files.to_h do |file|
  entry = JSON.parse(File.read(file))
  repository = File.basename(file, '.json')
  abort "#{file}: invalid digest artifact" unless entry.is_a?(Hash) && entry.keys.sort == %w[image revision service]
  service = keys_by_repository.fetch(repository)
  image = entry.fetch('image')
  expected = "ghcr.io/pahuldeepp/grainguard/#{repository}@sha256:"
  abort "#{service}: digest artifact does not match the signed commit and image" unless
    entry.fetch('service') == service && entry.fetch('revision') == revision &&
    image.is_a?(String) && image.start_with?(expected) &&
    image.delete_prefix(expected).match?(/\A[a-f0-9]{64}\z/)
  [service, image]
  end
end

runtime_keys = names.to_h { |service| [service, service] }
images = verified_artifacts(runtime_files, revision, source_repositories: names, keys_by_repository: runtime_keys,
                            description: 'runtime')
ai_services = ai_repository_names.to_h { |name| [name, name] }
ai_images = verified_artifacts(ai_files, revision, source_repositories: ai_repository_names,
                               keys_by_repository: ai_services, description: 'AI runtime')

abort 'synthetic scorer digest artifact missing' unless synthetic_file
synthetic_artifact = JSON.parse(File.read(synthetic_file))
synthetic_image = synthetic_artifact.fetch('image')
synthetic_prefix = 'ghcr.io/pahuldeepp/grainguard/ml-scoring-synthetic@sha256:'
abort 'synthetic scorer digest is not from this signed CI commit' unless
  synthetic_artifact.keys.sort == %w[image revision service] &&
  synthetic_artifact.fetch('service') == 'ml-scoring-synthetic' &&
  synthetic_artifact.fetch('revision') == revision &&
  synthetic_image.is_a?(String) && synthetic_image.start_with?(synthetic_prefix) &&
  synthetic_image.delete_prefix(synthetic_prefix).match?(/\A[a-f0-9]{64}\z/)

migration_inventory = JSON.parse(File.read(File.join(__dir__, 'owner-migration-inventory.json')))
migration_keys = migration_inventory.to_h { |owner| ["migration-#{owner.fetch('name')}", owner.fetch('name')] }
%w[migration-gate migration-sql].each { |tool| migration_keys[tool] = tool }
migration_files = Dir.glob(File.join(migration_artifact_dir, '*.json')).sort
migration_artifacts = verified_artifacts(migration_files, revision,
                                         source_repositories: migration_keys.keys,
                                         keys_by_repository: migration_keys,
                                         description: 'migration/tool')
migration_images = migration_artifacts.select { |name, _| migration_inventory.any? { |owner| owner.fetch('name') == name } }
tools = migration_artifacts.reject { |name, _| migration_images.key?(name) }
abort 'migration image inventory mismatch' unless migration_images.keys.sort == migration_inventory.map { |owner| owner.fetch('name') }.sort
abort 'migration tool image inventory mismatch' unless tools.keys.sort == %w[migration-gate migration-sql]

platform_entries = platform_inventory.fetch('images')
platform_files = Dir.glob(File.join(platform_artifact_dir, '*.json')).sort
expected_platform_names = platform_entries.map { |entry| entry.fetch('name') }.sort
abort 'platform image digest artifact inventory mismatch' unless platform_files.map { |file| File.basename(file, '.json') }.sort == expected_platform_names
platform_images = {}
platform_signature_gaps = []
platform_files.each do |file|
  entry = JSON.parse(File.read(file))
  name = File.basename(file, '.json')
  expected = platform_entries.find { |item| item.fetch('name') == name }
  abort "#{name}: invalid platform digest artifact" unless entry.is_a?(Hash) &&
    entry.keys.sort == %w[image kind revision service source source_signature_verified] &&
    entry.fetch('service') == name && entry.fetch('revision') == revision && entry.fetch('kind') == expected.fetch('kind')
  image = entry.fetch('image')
  prefix = "ghcr.io/pahuldeepp/grainguard/#{name}@sha256:"
  abort "#{name}: digest artifact is not an immutable CI GHCR image" unless image.is_a?(String) &&
    image.start_with?(prefix) && image.delete_prefix(prefix).match?(/\A[a-f0-9]{64}\z/)
  if expected.fetch('kind').start_with?('vendor')
    source = expected.fetch('source')
    source_digest = source.split('@', 2).last
    abort "#{name}: vendor digest was changed while mirroring" unless entry.fetch('source') == source && image.end_with?("@#{source_digest}")
    platform_signature_gaps << name unless entry.fetch('source_signature_verified') == true && expected.fetch('source_signature_verified') == true
  else
    abort "#{name}: repository-built image has an unexpected external source" unless entry.fetch('source').nil?
    abort "#{name}: repository-built image is not CI-attested" unless entry.fetch('source_signature_verified') == true
  end
  platform_images[name] = image
end

observability_names = %w[otel-collector prometheus grafana tempo loki]
data_plane_names = %w[pgbouncer kafka-topics kafka-connect connector-registration redis]
observability = observability_names.to_h { |name| [name, platform_images.fetch(name)] }
data_plane = data_plane_names.to_h { |name| [name, platform_images.fetch(name)] }
ai_runtime_complete = ai_missing_sources.empty? && ai_repository_names.sort == %w[grain-advisor knowledge-indexer knowledge-parser knowledge-service mcp-gateway model-gateway model-gateway-usage]
ai_runtime = ai_runtime_complete ? {
  'knowledge' => ai_images.fetch('knowledge-service'),
  'indexer' => ai_images.fetch('knowledge-indexer'),
  'parser' => ai_images.fetch('knowledge-parser'),
  'advisor' => ai_images.fetch('grain-advisor'),
  'gateway' => ai_images.fetch('model-gateway'),
  'usage' => ai_images.fetch('model-gateway-usage'),
  'mcp' => ai_images.fetch('mcp-gateway'),
  'clamav' => platform_images.fetch('clamav')
} : {}

probes = platform_inventory.fetch('acceptance_probes')
probe_chart_path = File.join(__dir__, 'acceptance-probes-chart', 'templates', 'probes.yaml')
probe_chart = File.read(probe_chart_path)
probe_roles = {
  'kafka' => platform_images.fetch('kafka-topics'),
  'redis' => platform_images.fetch('redis'),
  'cassandra' => platform_images.fetch('cassandra'),
  'opensearch_probe' => platform_images.fetch('cassandra'),
  'clickhouse' => platform_images.fetch('clickhouse'),
  'tenant_membership_readback' => images.fetch('tenant-control-plane')
}
probe_ready = probes.fetch('status') == 'ready' &&
  probes.fetch('chart') == 'infra/gitops/disposable/acceptance-probes-chart' &&
  probes.fetch('image_roles') == {
    'kafka' => 'data_plane_image_digests.kafka-topics',
    'redis' => 'data_plane_image_digests.redis',
    'cassandra' => 'cassandra_image_digest',
    'opensearch_probe' => 'cassandra_image_digest',
    'clickhouse' => 'clickhouse_image_digest',
    'tenant_membership_readback' => 'deployment_image_digests.tenant-control-plane'
  } && probe_chart.include?('.Values.clickhouseImage') && probe_chart.include?('/probe/clickhouse-roundtrip.sh') &&
  probe_chart.include?('.Values.tenantControlPlaneImage') && probe_chart.include?('command: [node, /probe/tenant-membership-readback.mjs]') &&
  probe_roles.values.all? { |reference| reference.match?(/@sha256:[a-f0-9]{64}\z/) }
source_coverage_complete = platform_signature_gaps.empty?
application_release_gaps = platform_inventory.fetch('application_release_gaps')
coverage = {
  'schemaVersion' => 1,
  'revision' => revision,
  'runtime_images_complete' => true,
  'ai_runtime_images_complete' => ai_runtime_complete,
  'ai_runtime_enabled' => false,
  'available_ai_images' => ai_images,
  'ai_runtime_missing_sources' => ai_missing_sources,
  'migration_images_complete' => true,
  'platform_images_complete' => true,
  'upstream_signature_gaps' => platform_signature_gaps,
  'acceptance_probes' => probes.merge('images' => probe_roles),
  'application_release_gaps' => application_release_gaps,
  'terraform_apply_eligible' => source_coverage_complete && probe_ready && application_release_gaps.empty?,
  'release_status' => source_coverage_complete && probe_ready && application_release_gaps.empty? ? (ai_runtime_complete ? 'ready' : 'ready_core_ai_disabled') : 'blocked'
}
coverage['blocking_reasons'] = []
coverage['blocking_reasons'] << 'one or more vendor source signatures/provenance have not been verified' unless source_coverage_complete
coverage['blocking_reasons'] << 'acceptance probe chart is not bound to exact signed image-role digests' unless probe_ready
coverage['ai_runtime_blocking_reasons'] = ai_missing_sources.map do |entry|
  "#{entry.fetch('name')}: required AI runtime source is missing (#{entry.fetch('expectedDockerfile')})"
end
application_release_gaps.each do |gap|
  coverage['blocking_reasons'] << "#{gap.fetch('name')}: #{gap.fetch('reason')}"
end

FileUtils.mkdir_p(output_dir)
File.write(File.join(output_dir, 'images.json'), JSON.pretty_generate(images) + "\n")
File.write(File.join(output_dir, 'migration-images.json'), JSON.pretty_generate(migration_images) + "\n")
File.write(File.join(output_dir, 'platform-images.json'), JSON.pretty_generate(platform_images) + "\n")
File.write(File.join(output_dir, 'release-coverage.json'), JSON.pretty_generate(coverage) + "\n")
File.write(File.join(output_dir, 'release-inputs.tfvars.json'), JSON.pretty_generate({
  'gitops_revision' => revision,
  'ml_synthetic_scorer_image_digest' => synthetic_image,
  'deployment_image_digests' => images,
  'migration_image_digests' => migration_images,
  'migration_gate_image_digest' => tools.fetch('migration-gate'),
  'migration_sql_image_digest' => tools.fetch('migration-sql'),
  'observability_image_digests' => observability,
  'data_plane_image_digests' => data_plane,
  'opensearch_image_digest' => platform_images.fetch('opensearch'),
  'cassandra_image_digest' => platform_images.fetch('cassandra'),
  'mqtt_image_digest' => platform_images.fetch('mqtt'),
  'clickhouse_image_digest' => platform_images.fetch('clickhouse'),
  'ai_runtime_enabled' => false,
  'ai_runtime_sources_complete' => ai_runtime_complete,
  'ai_runtime_image_digests' => ai_runtime
}) + "\n")
puts "Assembled #{images.length} runtime, #{ai_images.length} AI runtime, #{migration_images.length} owner migrations, #{tools.length} migration tools and #{platform_images.length} platform digests for #{revision}; release status: #{coverage.fetch('release_status')}."
