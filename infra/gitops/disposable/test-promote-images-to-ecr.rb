#!/usr/bin/env ruby
require 'json'
require 'tmpdir'
require 'fileutils'
require 'digest'

script = File.join(__dir__, 'promote-images-to-ecr.rb')
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
services = contract.fetch('releases').map { |release| release.fetch('image') }.uniq.sort
owners = JSON.parse(File.read(File.join(__dir__, 'owner-migration-inventory.json'))).map { |owner| owner.fetch('name') }.sort
platform_inventory = JSON.parse(File.read(File.join(__dir__, 'platform-image-inventory.json')))
platform_names = platform_inventory.fetch('images').map { |entry| entry.fetch('name') }.sort
ai_repository_by_key = {'knowledge' => 'knowledge-service', 'indexer' => 'knowledge-indexer',
                        'parser' => 'knowledge-parser', 'advisor' => 'grain-advisor',
                        'gateway' => 'model-gateway', 'usage' => 'model-gateway-usage', 'mcp' => 'mcp-gateway'}
ai_present_names = platform_inventory.fetch('ai_runtime_images').select { |entry| entry.fetch('status') == 'source_present' }.map { |entry| entry.fetch('name') }
repositories = (services + owners.map { |owner| "migration-#{owner}" } + %w[migration-gate migration-sql ml-scoring-synthetic] + platform_names + ai_present_names).uniq.sort
revision = 'a' * 40
account = '123456789012'
region = 'us-east-1'
registry = "#{account}.dkr.ecr.#{region}.amazonaws.com"
digest = "sha256:#{'b' * 64}"

Dir.mktmpdir('greenguard-ecr-promotion-') do |directory|
  bin = File.join(directory, 'bin')
  FileUtils.mkdir_p(bin)
  log = File.join(directory, 'calls')
  File.write(File.join(bin, 'aws'), <<~SH)
    #!/bin/sh
    echo "aws $*" >> "$GG_PROMOTION_LOG"
    case "$1 $2" in
      'sts get-caller-identity') if [ -f "$GG_PROMOTION_WRONG_ACCOUNT" ]; then echo 999999999999; else echo 123456789012; fi ;;
      'ecr get-login-password') echo temporary-token ;;
      'ecr describe-images') if [ -f "$GG_PROMOTION_BAD_DIGEST" ]; then echo '{"imageDetails":[{"imageDigest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}]}'; else echo '{"imageDetails":[{"imageDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}'; fi ;;
    esac
  SH
  File.write(File.join(bin, 'cosign'), <<~SH)
    #!/bin/sh
    echo "cosign $*" >> "$GG_PROMOTION_LOG"
    [ ! -f "$GG_PROMOTION_BAD_SIGNATURE" ]
  SH
  File.write(File.join(bin, 'skopeo'), <<~SH)
    #!/bin/sh
    echo "skopeo $*" >> "$GG_PROMOTION_LOG"
    [ "$1" != login ] || { IFS= read -r password; [ "$password" = temporary-token ]; }
  SH
  Dir.glob(File.join(bin, '*')).each { |file| File.chmod(0o755, file) }
  inputs = File.join(directory, 'release-inputs.json')
  coverage = File.join(directory, 'release-coverage.json')
  urls = File.join(directory, 'ecr-urls.json')
  cell = File.join(directory, 'cell.json')
  deployment = services.to_h { |name| [name, "ghcr.io/pahuldeepp/grainguard/#{name}@#{digest}"] }
  migration = owners.to_h { |name| [name, "ghcr.io/pahuldeepp/grainguard/migration-#{name}@#{digest}"] }
  tools = %w[migration-gate migration-sql].to_h { |name| [name, "ghcr.io/pahuldeepp/grainguard/#{name}@#{digest}"] }
  synthetic = "ghcr.io/pahuldeepp/grainguard/ml-scoring-synthetic@#{digest}"
  platform = platform_names.to_h { |name| [name, "ghcr.io/pahuldeepp/grainguard/#{name}@#{digest}"] }
  observability_names = %w[otel-collector prometheus grafana tempo loki]
  data_plane_names = %w[pgbouncer kafka-topics kafka-connect connector-registration redis]
  available_ai = ai_present_names.to_h { |name| [name, "ghcr.io/pahuldeepp/grainguard/#{name}@#{digest}"] }
  ai_sources = ai_repository_by_key.to_h { |key, name| [key, "ghcr.io/pahuldeepp/grainguard/#{name}@#{digest}"] }
  ai_images = {**ai_sources, 'clamav' => platform.fetch('clamav')}
  File.write(inputs, JSON.generate({
    'gitops_revision' => revision,
    'deployment_image_digests' => deployment,
    'migration_image_digests' => migration,
    'migration_gate_image_digest' => tools.fetch('migration-gate'),
    'migration_sql_image_digest' => tools.fetch('migration-sql'),
    'ml_synthetic_scorer_image_digest' => synthetic,
    'observability_image_digests' => observability_names.to_h { |name| [name, platform.fetch(name)] },
    'data_plane_image_digests' => data_plane_names.to_h { |name| [name, platform.fetch(name)] },
    'opensearch_image_digest' => platform.fetch('opensearch'),
    'cassandra_image_digest' => platform.fetch('cassandra'),
    'mqtt_image_digest' => platform.fetch('mqtt'),
    'clickhouse_image_digest' => platform.fetch('clickhouse'),
    'clamav_image_digest' => platform.fetch('clamav'),
    'ai_runtime_enabled' => false,
    'ai_runtime_sources_complete' => true,
    'ai_runtime_image_digests' => ai_images
  }))
  File.write(coverage, JSON.generate({
    'schemaVersion' => 1, 'revision' => revision, 'terraform_apply_eligible' => true, 'application_release_gaps' => [],
    'release_status' => 'ready_core_ai_disabled', 'blocking_reasons' => [], 'upstream_signature_gaps' => [],
    'ai_runtime_images_complete' => true, 'ai_runtime_enabled' => false, 'available_ai_images' => available_ai,
    'ai_runtime_missing_sources' => [],
    'acceptance_probes' => {
      'status' => 'ready', 'chart' => 'infra/gitops/disposable/acceptance-probes-chart',
      'images' => {'kafka' => platform.fetch('kafka-topics'), 'redis' => platform.fetch('redis'),
                   'cassandra' => platform.fetch('cassandra'), 'opensearch_probe' => platform.fetch('cassandra'),
                   'clickhouse' => platform.fetch('clickhouse'),
                   'tenant_membership_readback' => deployment.fetch('tenant-control-plane')}
    }
  }))
  repository_prefix = "greenguard/sandbox/cell-#{Digest::SHA256.hexdigest('greenguard-sandbox-cell-1')[0, 16]}"
  repositories_by_name = repositories.to_h { |name| [name, "#{registry}/#{repository_prefix}/#{name}"] }
  File.write(urls, JSON.generate(repositories_by_name))
  File.write(cell, JSON.generate('region' => region, 'account_id' => account,
                                 'cluster_name' => 'greenguard-sandbox-cell-1', 'environment' => 'sandbox'))
  environment = {
    'PATH' => "#{bin}:#{ENV.fetch('PATH')}",
    'GG_PROMOTION_LOG' => log,
    'GG_PROMOTION_WRONG_ACCOUNT' => File.join(directory, 'flag-wrong-account'),
    'GG_PROMOTION_BAD_SIGNATURE' => File.join(directory, 'flag-bad-signature'),
    'GG_PROMOTION_BAD_DIGEST' => File.join(directory, 'flag-bad-digest')
  }
  run = lambda do |name|
    output = File.join(directory, name)
    [system(environment, 'ruby', script, inputs, coverage, urls, cell, output, out: File::NULL, err: File::NULL), output]
  end

  succeeded, output = run.call('valid')
  abort 'valid promotion rejected' unless succeeded
  promoted = JSON.parse(File.read(File.join(output, 'release-inputs.tfvars.json')))
  expected_deployment = services.to_h { |name| [name, "#{registry}/#{repository_prefix}/#{name}@#{digest}"] }
  expected_migration = owners.to_h { |name| [name, "#{registry}/#{repository_prefix}/migration-#{name}@#{digest}"] }
  expected_platform = platform_names.to_h { |name| [name, "#{registry}/#{repository_prefix}/#{name}@#{digest}"] }
  abort 'ECR runtime manifest mismatch' unless promoted.fetch('deployment_image_digests') == expected_deployment
  abort 'ECR owner migration manifest mismatch' unless promoted.fetch('migration_image_digests') == expected_migration
  abort 'ECR kubectl image mismatch' unless promoted.fetch('migration_gate_image_digest') == "#{registry}/#{repository_prefix}/migration-gate@#{digest}"
  abort 'ECR PostgreSQL image mismatch' unless promoted.fetch('migration_sql_image_digest') == "#{registry}/#{repository_prefix}/migration-sql@#{digest}"
  abort 'ECR synthetic scorer image mismatch' unless promoted.fetch('ml_synthetic_scorer_image_digest') == "#{registry}/#{repository_prefix}/ml-scoring-synthetic@#{digest}"
  abort 'ECR observability image map mismatch' unless promoted.fetch('observability_image_digests') == observability_names.to_h { |name| [name, expected_platform.fetch(name)] }
  abort 'ECR data-plane image map mismatch' unless promoted.fetch('data_plane_image_digests') == data_plane_names.to_h { |name| [name, expected_platform.fetch(name)] }
  abort 'ECR server images mismatch' unless promoted.fetch('opensearch_image_digest') == expected_platform.fetch('opensearch') &&
    promoted.fetch('cassandra_image_digest') == expected_platform.fetch('cassandra') &&
    promoted.fetch('mqtt_image_digest') == expected_platform.fetch('mqtt') &&
    promoted.fetch('clickhouse_image_digest') == expected_platform.fetch('clickhouse')
  abort 'ECR AI image map does not contain all eight digests while disabled by default' unless promoted.fetch('ai_runtime_image_digests').keys.sort == %w[advisor clamav gateway indexer knowledge mcp parser usage] &&
    promoted.fetch('ai_runtime_enabled') == false && promoted.fetch('ai_runtime_sources_complete') == true
  expected_available_ai = ai_present_names.to_h { |name| [name, "#{registry}/#{repository_prefix}/#{name}@#{digest}"] }
  promoted_coverage = JSON.parse(File.read(File.join(output, 'release-coverage.json')))
  abort 'ECR available AI images were not limited to checked-in services' unless promoted_coverage.fetch('available_ai_images') == expected_available_ai
  baseline_inputs = File.read(inputs)
  invalid_ai = JSON.parse(baseline_inputs)
  invalid_ai['ai_runtime_enabled'] = true
  invalid_ai['ai_runtime_sources_complete'] = false
  invalid_ai['ai_runtime_image_digests'] = {'knowledge' => 'ghcr.io/pahuldeepp/grainguard/knowledge-service@' + digest}
  File.write(inputs, JSON.generate(invalid_ai))
  succeeded, output = run.call('missing-ai-source')
  abort 'AI enablement with missing sources was accepted' if succeeded || File.exist?(output)
  File.write(inputs, baseline_inputs)
  abort 'cell-scoped ECR repository name missing from API query' unless
    File.read(log).include?("--repository-name #{repository_prefix}/migration-")
  calls = File.read(log)
  abort 'signature verification inventory mismatch' unless calls.scan(/^cosign verify /).length == repositories.length
  abort 'multi-architecture digest preservation missing' unless calls.scan(/^skopeo copy --all --preserve-digests /).length == repositories.length
  abort 'ECR digest lookup inventory mismatch' unless calls.scan(/^aws ecr describe-images /).length == repositories.length

  File.write(environment.fetch('GG_PROMOTION_WRONG_ACCOUNT'), '')
  succeeded, output = run.call('wrong-account')
  abort 'wrong account accepted' if succeeded || File.exist?(output)
  File.unlink(environment.fetch('GG_PROMOTION_WRONG_ACCOUNT'))

  File.write(environment.fetch('GG_PROMOTION_BAD_SIGNATURE'), '')
  succeeded, output = run.call('bad-signature')
  abort 'bad signature accepted' if succeeded || File.exist?(output)
  File.unlink(environment.fetch('GG_PROMOTION_BAD_SIGNATURE'))

  File.write(environment.fetch('GG_PROMOTION_BAD_DIGEST'), '')
  succeeded, output = run.call('bad-digest')
  abort 'changed ECR digest accepted' if succeeded || File.exist?(output)
  File.unlink(environment.fetch('GG_PROMOTION_BAD_DIGEST'))

  File.write(coverage, JSON.generate({'schemaVersion' => 1, 'revision' => revision,
                                     'terraform_apply_eligible' => false, 'upstream_signature_gaps' => [],
                                     'acceptance_probes' => {'status' => 'ready'},
                                     'release_status' => 'blocked', 'blocking_reasons' => ['unverified upstream']}))
  before = File.read(log)
  succeeded, output = run.call('blocked-release')
  abort 'blocked release reached AWS or was promoted' if succeeded || File.exist?(output) || File.read(log) != before

  File.write(urls, JSON.generate(repositories_by_name.merge('migration-control' => "999999999999.dkr.ecr.#{region}.amazonaws.com/#{repository_prefix}/migration-control")))
  succeeded, output = run.call('foreign-repository')
  abort 'foreign repository accepted' if succeeded || File.exist?(output)

  File.write(urls, JSON.generate(repositories_by_name))
  File.write(coverage, JSON.generate({
    'schemaVersion' => 1, 'revision' => revision, 'terraform_apply_eligible' => true, 'application_release_gaps' => [],
    'release_status' => 'ready', 'blocking_reasons' => [], 'upstream_signature_gaps' => [],
    'acceptance_probes' => {
      'status' => 'ready', 'chart' => 'infra/gitops/disposable/acceptance-probes-chart',
      'images' => {'kafka' => platform.fetch('kafka-topics'), 'redis' => platform.fetch('redis'),
                   'cassandra' => platform.fetch('cassandra'), 'opensearch_probe' => platform.fetch('cassandra'),
                   'clickhouse' => platform.fetch('clickhouse'),
                   'tenant_membership_readback' => deployment.fetch('tenant-control-plane')}
    }
  }))
  File.write(inputs, JSON.generate({
    'gitops_revision' => revision, 'deployment_image_digests' => deployment,
    'migration_image_digests' => migration.reject { |name, _| name == 'risk' },
    'migration_gate_image_digest' => tools.fetch('migration-gate'),
    'migration_sql_image_digest' => tools.fetch('migration-sql')
  }))
  succeeded, output = run.call('missing-migration')
  abort 'missing owner migration accepted' if succeeded || File.exist?(output)
end
puts "ECR promotion: #{services.length} runtime, #{owners.length} owner migrations, 2 tools, #{platform_names.length} platform images, #{ai_present_names.length} AI images; AI is disabled by default and guarded by complete digest coverage."
