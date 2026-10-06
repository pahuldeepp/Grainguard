#!/usr/bin/env ruby
# Reverify signed GHCR images, copy every architecture without changing its
# digest, then emit the Terraform input using this cell's ECR references.
require 'json'
require 'digest'
require 'fileutils'
require 'open3'
require 'tempfile'

abort 'usage: promote-images-to-ecr.rb RELEASE_INPUTS_JSON RELEASE_COVERAGE_JSON ECR_URLS_JSON CELL_IDENTITY_JSON OUTPUT_DIRECTORY' unless ARGV.length == 5
inputs_path, coverage_path, urls_path, identity_path, output_dir = ARGV
abort 'output directory already exists' if File.exist?(output_dir)
inputs = JSON.parse(File.read(inputs_path))
coverage = JSON.parse(File.read(coverage_path))
urls = JSON.parse(File.read(urls_path))
cell = JSON.parse(File.read(identity_path))
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
services = contract.fetch('releases').map { |release| release.fetch('image') }.uniq.sort
owners = JSON.parse(File.read(File.join(__dir__, 'owner-migration-inventory.json'))).map { |owner| owner.fetch('name') }.sort
tool_repositories = %w[migration-gate migration-sql]
expected_fields = %w[ai_runtime_enabled ai_runtime_image_digests ai_runtime_sources_complete cassandra_image_digest clamav_image_digest clickhouse_image_digest data_plane_image_digests deployment_image_digests gitops_revision migration_gate_image_digest migration_image_digests migration_sql_image_digest ml_synthetic_scorer_image_digest mqtt_image_digest observability_image_digests opensearch_image_digest]
abort 'invalid release inputs' unless inputs.is_a?(Hash) && inputs.keys.sort == expected_fields
abort 'release coverage is missing or malformed' unless coverage.is_a?(Hash) && coverage['schemaVersion'] == 1
abort "release is blocked: #{Array(coverage['blocking_reasons']).join('; ')}" unless coverage['terraform_apply_eligible'] == true && %w[ready ready_core_ai_disabled].include?(coverage['release_status'])
revision = inputs.fetch('gitops_revision')
abort 'revision must be a full Git commit SHA' unless revision.is_a?(String) && revision.match?(/\A[a-f0-9]{40}\z/)
abort 'release coverage revision mismatch' unless coverage['revision'] == revision
abort 'release coverage has unverified vendor provenance' unless coverage['upstream_signature_gaps'] == []
abort 'release coverage contains an unprovisioned application image' unless coverage['application_release_gaps'] == []
probe = coverage.fetch('acceptance_probes')
expected_probe_images = {
  'clickhouse' => inputs.fetch('clickhouse_image_digest'),
  'tenant_membership_readback' => inputs.fetch('deployment_image_digests').fetch('tenant-control-plane')
}
abort 'release coverage lacks exact acceptance probe image roles' unless probe.is_a?(Hash) &&
  probe['status'] == 'ready' && probe['chart'] == 'infra/gitops/disposable/acceptance-probes-chart' &&
  probe['images'] == expected_probe_images
migration_source = inputs.fetch('migration_image_digests')
abort 'owner migration image inventory mismatch' unless migration_source.is_a?(Hash) && migration_source.keys.sort == owners
source = inputs.fetch('deployment_image_digests')
abort 'runtime image inventory mismatch' unless source.is_a?(Hash) && source.keys.sort == services
tool_source = {
  'migration-gate' => inputs.fetch('migration_gate_image_digest'),
  'migration-sql' => inputs.fetch('migration_sql_image_digest')
}
synthetic_source = inputs.fetch('ml_synthetic_scorer_image_digest')
platform_inventory = JSON.parse(File.read(File.join(__dir__, 'platform-image-inventory.json')))
platform_names = platform_inventory.fetch('images').map { |entry| entry.fetch('name') }.sort
observability_source = inputs.fetch('observability_image_digests')
data_plane_source = inputs.fetch('data_plane_image_digests')
ai_source = inputs.fetch('ai_runtime_image_digests')
ai_enabled = inputs.fetch('ai_runtime_enabled')
ai_sources_complete = inputs.fetch('ai_runtime_sources_complete')
ai_available = coverage.fetch('available_ai_images')
abort 'release coverage must label AI as explicitly disabled' unless coverage.fetch('ai_runtime_enabled') == false
ai_inventory = platform_inventory.fetch('ai_runtime_images')
ai_present_names = ai_inventory.select { |entry| entry.fetch('status') == 'source_present' }.map { |entry| entry.fetch('name') }.sort
ai_missing_names = ai_inventory.select { |entry| entry.fetch('status') == 'blocked_missing_source' }.map { |entry| entry.fetch('name') }.sort
abort 'AI source coverage does not match checked-in source inventory' unless coverage.fetch('ai_runtime_images_complete') == ai_sources_complete &&
  ai_sources_complete == ai_missing_names.empty? && ai_available.is_a?(Hash) && ai_available.keys.sort == ai_present_names
abort 'disposable release promotion must keep AI explicitly disabled' unless ai_enabled == false
if ai_sources_complete
  abort 'complete AI runtime source inventory requires all eight image digests' unless ai_source.keys.sort == %w[advisor clamav gateway indexer knowledge mcp parser usage]
else
  abort 'missing AI services must not have an assembled AI image map' unless ai_source == {}
end
required_observability = %w[otel-collector prometheus grafana tempo loki]
required_data_plane = %w[pgbouncer kafka-topics kafka-connect connector-registration]
abort 'observability source inventory mismatch' unless observability_source.is_a?(Hash) && observability_source.keys.sort == required_observability.sort
abort 'data-plane source inventory mismatch' unless data_plane_source.is_a?(Hash) && data_plane_source.keys.sort == required_data_plane.sort
abort 'AI runtime source inventory mismatch' unless ai_source.is_a?(Hash)
platform_source = observability_source.merge(data_plane_source).merge(
  'opensearch' => inputs.fetch('opensearch_image_digest'),
  'cassandra' => inputs.fetch('cassandra_image_digest'),
  'mqtt' => inputs.fetch('mqtt_image_digest'),
  'clickhouse' => inputs.fetch('clickhouse_image_digest'),
  'clamav' => inputs.fetch('clamav_image_digest')
)
abort 'platform release image inventory mismatch' unless platform_source.keys.sort == platform_names
ai_repository_by_key = {
  'knowledge' => 'knowledge-service', 'indexer' => 'knowledge-indexer', 'parser' => 'knowledge-parser',
  'advisor' => 'grain-advisor', 'gateway' => 'model-gateway', 'usage' => 'model-gateway-usage',
  'mcp' => 'mcp-gateway'
}
if ai_sources_complete
  expected_ai_sources = ai_repository_by_key.to_h { |key, repository| [key, ai_available.fetch(repository)] }
  expected_ai_sources['clamav'] = inputs.fetch('clamav_image_digest')
  abort 'AI Terraform map is not bound to the exact available image artifacts' unless ai_source == expected_ai_sources
end
all_repositories = services + owners.map { |owner| "migration-#{owner}" } + tool_repositories + ['ml-scoring-synthetic'] + platform_names + ai_available.keys
abort 'ECR repository inventory mismatch' unless urls.is_a?(Hash) && urls.keys.sort == all_repositories.sort
abort 'invalid Terraform cell identity' unless cell.is_a?(Hash) && cell.keys.sort == %w[account_id cluster_name environment region]
account = cell.fetch('account_id')
region = cell.fetch('region')
environment = cell.fetch('environment')
cluster_name = cell.fetch('cluster_name')
abort 'invalid Terraform account or region' unless account.is_a?(String) && account.match?(/\A[0-9]{12}\z/) &&
  region.is_a?(String) && region.match?(/\A[a-z]{2}-[a-z]+-[0-9]+\z/)
abort 'invalid Terraform cell identity' unless environment.is_a?(String) && environment.match?(/\A[a-z][a-z0-9-]{1,15}\z/) &&
  cluster_name.is_a?(String) && cluster_name.match?(/\A[A-Za-z0-9][A-Za-z0-9_-]{0,99}\z/)
registry = "#{account}.dkr.ecr.#{region}.amazonaws.com"
ecr_prefix = "greenguard/#{environment}/cell-#{Digest::SHA256.hexdigest(cluster_name)[0, 16]}"
references = {}
services.each { |service| references[service] = source.fetch(service) }
owners.each { |owner| references["migration-#{owner}"] = migration_source.fetch(owner) }
tool_source.each { |repository, reference| references[repository] = reference }
references['ml-scoring-synthetic'] = synthetic_source
references.merge!(platform_source)
ai_available.each { |repository, reference| references[repository] = reference }
if ai_enabled
  ai_repository_by_key.each { |key, repository| references[repository] = ai_source.fetch(key) }
end
references.each do |repository, reference|
  expected_source = "ghcr.io/pahuldeepp/grainguard/#{repository}@sha256:"
  abort "#{repository}: source must be the signed GHCR digest" unless reference.is_a?(String) &&
    reference.start_with?(expected_source) && reference.delete_prefix(expected_source).match?(/\A[a-f0-9]{64}\z/)
  expected_url = "#{registry}/#{ecr_prefix}/#{repository}"
  abort "#{repository}: ECR URL does not match this Terraform cell" unless urls.fetch(repository) == expected_url
end

def command(*args, input: nil)
  stdout, stderr, status = Open3.capture3(*args, stdin_data: input.to_s)
  abort "promotion command failed: #{args.first} #{args[1]}: #{stderr}" unless status.success?
  stdout.strip
end

actual_account = command('aws', 'sts', 'get-caller-identity', '--query', 'Account', '--output', 'text')
abort "AWS account mismatch: expected #{account}, got #{actual_account}" unless actual_account == account
password = command('aws', 'ecr', 'get-login-password', '--region', region)
abort 'ECR login password unavailable' if password.empty?
destination = {}
Tempfile.create('greenguard-ecr-auth') do |auth|
  command('skopeo', 'login', '--authfile', auth.path, '--username', 'AWS', '--password-stdin', registry,
          input: "#{password}\n")
  password = nil
  references.each do |repository, reference|
    command('cosign', 'verify', '--certificate-identity',
            'https://github.com/pahuldeepp/Grainguard/.github/workflows/ci.yml@refs/heads/main',
            '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com', reference)
    target = "#{urls.fetch(repository)}:sha-#{revision}"
    command('skopeo', 'copy', '--all', '--preserve-digests', '--dest-authfile', auth.path,
            "docker://#{reference}", "docker://#{target}")
    repository_name = urls.fetch(repository).delete_prefix("#{registry}/")
    details = JSON.parse(command('aws', 'ecr', 'describe-images', '--region', region,
                                 '--repository-name', repository_name,
                                 '--image-ids', "imageTag=sha-#{revision}", '--output', 'json'))
    digest = details.fetch('imageDetails').fetch(0).fetch('imageDigest')
    abort "#{repository}: ECR digest changed during promotion" unless digest == reference.split('@').last
    destination[repository] = "#{urls.fetch(repository)}@#{digest}"
  end
end

deployment_destination = services.to_h { |service| [service, destination.fetch(service)] }
migration_destination = owners.to_h { |owner| [owner, destination.fetch("migration-#{owner}")] }
observability_destination = required_observability.to_h { |name| [name, destination.fetch(name)] }
data_plane_destination = required_data_plane.to_h { |name| [name, destination.fetch(name)] }
ai_runtime_destination = ai_sources_complete ? {
  'knowledge' => destination.fetch('knowledge-service'),
  'indexer' => destination.fetch('knowledge-indexer'),
  'parser' => destination.fetch('knowledge-parser'),
  'advisor' => destination.fetch('grain-advisor'),
  'gateway' => destination.fetch('model-gateway'),
  'usage' => destination.fetch('model-gateway-usage'),
  'mcp' => destination.fetch('mcp-gateway'),
  'clamav' => destination.fetch('clamav')
} : {}

FileUtils.mkdir_p(output_dir)
File.write(File.join(output_dir, 'release-inputs.tfvars.json'), JSON.pretty_generate({
  'gitops_revision' => revision,
  'deployment_image_digests' => deployment_destination,
  'migration_image_digests' => migration_destination,
  'migration_gate_image_digest' => destination.fetch('migration-gate'),
  'migration_sql_image_digest' => destination.fetch('migration-sql'),
  'ml_synthetic_scorer_image_digest' => destination.fetch('ml-scoring-synthetic'),
  'observability_image_digests' => observability_destination,
  'data_plane_image_digests' => data_plane_destination,
  'opensearch_image_digest' => destination.fetch('opensearch'),
  'cassandra_image_digest' => destination.fetch('cassandra'),
  'mqtt_image_digest' => destination.fetch('mqtt'),
  'clickhouse_image_digest' => destination.fetch('clickhouse'),
  'clamav_image_digest' => destination.fetch('clamav'),
  'ai_runtime_enabled' => false,
  'ai_runtime_sources_complete' => ai_sources_complete,
  'ai_runtime_image_digests' => ai_runtime_destination
}) + "\n")
File.write(File.join(output_dir, 'images.json'), JSON.pretty_generate(deployment_destination) + "\n")
File.write(File.join(output_dir, 'migration-images.json'), JSON.pretty_generate(migration_destination) + "\n")
File.write(File.join(output_dir, 'platform-images.json'), JSON.pretty_generate(platform_names.to_h { |name| [name, destination.fetch(name)] }) + "\n")
promoted_coverage = Marshal.load(Marshal.dump(coverage))
promoted_coverage['acceptance_probes']['images'] = {
  'clickhouse' => destination.fetch('clickhouse'),
  'tenant_membership_readback' => destination.fetch('tenant-control-plane')
}
promoted_coverage['available_ai_images'] = ai_available.keys.to_h { |repository| [repository, destination.fetch(repository)] }
promoted_coverage['ai_runtime_enabled'] = false
File.write(File.join(output_dir, 'release-coverage.json'), JSON.pretty_generate(promoted_coverage.merge('ecr_promotion_completed' => true)) + "\n")
puts "Promoted #{services.length} runtime, #{owners.length} owner migrations, #{tool_source.length} tools, 1 synthetic scorer and #{platform_names.length} platform digests into #{registry}."
