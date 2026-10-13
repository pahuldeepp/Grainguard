#!/usr/bin/env ruby
require 'json'
require 'tmpdir'
require 'fileutils'

assembler = File.join(__dir__, 'assemble-ci-digests.rb')
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
owners = JSON.parse(File.read(File.join(__dir__, 'owner-migration-inventory.json'))).map { |entry| entry.fetch('name') }
runtime = contract.fetch('releases').map { |release| release.fetch('image') }.uniq
platform_inventory = JSON.parse(File.read(File.join(__dir__, 'platform-image-inventory.json')))
ai_inventory = platform_inventory.fetch('ai_runtime_images')
ai_services = ai_inventory.select { |entry| entry.fetch('status') == 'source_present' }.map { |entry| entry.fetch('name') }
migration_repositories = owners.to_h { |owner| ["migration-#{owner}", owner] }.merge(
  'migration-gate' => 'migration-gate', 'migration-sql' => 'migration-sql')
revision = 'a' * 40

Dir.mktmpdir('greenguard-ci-digests-') do |directory|
  runtime_artifacts = File.join(directory, 'runtime')
  migration_artifacts = File.join(directory, 'migration')
  platform_artifacts = File.join(directory, 'platform')
  FileUtils.mkdir_p([runtime_artifacts, migration_artifacts, platform_artifacts])
  runtime.each do |service|
    entry = {'service' => service, 'image' => "ghcr.io/pahuldeepp/grainguard/#{service}@sha256:#{'b' * 64}", 'revision' => revision}
    File.write(File.join(runtime_artifacts, "#{service}.json"), JSON.generate(entry))
  end
  ai_services.each do |service|
    entry = {'service' => service, 'image' => "ghcr.io/pahuldeepp/grainguard/#{service}@sha256:#{'e' * 64}", 'revision' => revision}
    File.write(File.join(runtime_artifacts, "#{service}.json"), JSON.generate(entry))
  end
  synthetic = {'service' => 'ml-scoring-synthetic', 'image' => "ghcr.io/pahuldeepp/grainguard/ml-scoring-synthetic@sha256:#{'f' * 64}", 'revision' => revision}
  File.write(File.join(runtime_artifacts, 'ml-scoring-synthetic.json'), JSON.generate(synthetic))
  migration_repositories.each do |repository, service|
    entry = {'service' => service, 'image' => "ghcr.io/pahuldeepp/grainguard/#{repository}@sha256:#{'c' * 64}", 'revision' => revision}
    File.write(File.join(migration_artifacts, "#{repository}.json"), JSON.generate(entry))
  end
  platform_inventory.fetch('images').each do |entry|
    name = entry.fetch('name')
    kind = entry.fetch('kind')
    source = entry['source']
    digest = kind.start_with?('vendor') ? source.split('@', 2).last : "sha256:#{'d' * 64}"
    artifact = {
      'service' => name,
      'image' => "ghcr.io/pahuldeepp/grainguard/#{name}@#{digest}",
      'revision' => revision,
      'kind' => kind,
      'source' => source,
      'source_signature_verified' => kind == 'build'
    }
    File.write(File.join(platform_artifacts, "#{name}.json"), JSON.generate(artifact))
  end
  output = File.join(directory, 'valid')
  args = ['ruby', assembler, runtime_artifacts, migration_artifacts, platform_artifacts, revision, output]
  abort 'valid digest artifacts rejected' unless system(*args)
  generated = JSON.parse(File.read(File.join(output, 'release-inputs.tfvars.json')))
  abort 'revision mismatch' unless generated.fetch('gitops_revision') == revision
  abort 'synthetic scorer digest missing' unless generated.fetch('ml_synthetic_scorer_image_digest') == synthetic.fetch('image')
  abort 'runtime inventory mismatch' unless generated.fetch('deployment_image_digests').keys.sort == runtime.sort
  abort 'owner migration inventory mismatch' unless generated.fetch('migration_image_digests').keys.sort == owners.sort
  abort 'kubectl tool digest missing' unless generated.fetch('migration_gate_image_digest') == "ghcr.io/pahuldeepp/grainguard/migration-gate@sha256:#{'c' * 64}"
  abort 'PostgreSQL tool digest missing' unless generated.fetch('migration_sql_image_digest') == "ghcr.io/pahuldeepp/grainguard/migration-sql@sha256:#{'c' * 64}"
  abort 'runtime image manifest mismatch' unless JSON.parse(File.read(File.join(output, 'images.json'))) == generated.fetch('deployment_image_digests')
  abort 'migration image manifest mismatch' unless JSON.parse(File.read(File.join(output, 'migration-images.json'))) == generated.fetch('migration_image_digests')
  expected_observability = %w[otel-collector prometheus grafana tempo loki]
  expected_data_plane = %w[pgbouncer kafka-topics kafka-connect connector-registration redis]
  abort 'observability image contract mismatch' unless generated.fetch('observability_image_digests').keys.sort == expected_observability.sort
  abort 'data-plane image contract mismatch' unless generated.fetch('data_plane_image_digests').keys.sort == expected_data_plane.sort
  abort 'server image contract mismatch' unless %w[opensearch_image_digest cassandra_image_digest mqtt_image_digest clickhouse_image_digest].all? { |field| generated.key?(field) }
  abort 'AI remains explicitly disabled even when source images are assembled' unless generated.fetch('ai_runtime_enabled') == false &&
    generated.fetch('ai_runtime_sources_complete') == true &&
    generated.fetch('ai_runtime_image_digests').keys.sort == %w[advisor clamav gateway indexer knowledge mcp parser usage]
  coverage = JSON.parse(File.read(File.join(output, 'release-coverage.json')))
  abort 'AI runtime source coverage should include every checked-in image' unless coverage.fetch('ai_runtime_images_complete') == true &&
    coverage.fetch('available_ai_images').keys.sort == %w[grain-advisor knowledge-indexer knowledge-parser knowledge-service mcp-gateway model-gateway model-gateway-usage] &&
    coverage.fetch('ai_runtime_missing_sources') == []
  abort 'unsigned vendor dependencies did not block Terraform apply' unless coverage.fetch('terraform_apply_eligible') == false && coverage.fetch('release_status') == 'blocked'
  abort 'vendor signature gaps are not explicit' unless coverage.fetch('upstream_signature_gaps').sort == platform_inventory.fetch('images').select { |item| item.fetch('kind').start_with?('vendor') }.map { |item| item.fetch('name') }.sort
  abort 'telemetry-sinks CI source is absent' unless File.read(File.join(__dir__, '../../../.github/workflows/ci.yml')).include?('dockerfile: services/telemetry-sinks/deploy/Dockerfile')
  abort 'data probe image roles are missing' unless
    coverage.dig('acceptance_probes', 'images', 'kafka') == generated.fetch('data_plane_image_digests').fetch('kafka-topics') &&
    coverage.dig('acceptance_probes', 'images', 'redis') == generated.fetch('data_plane_image_digests').fetch('redis') &&
    coverage.dig('acceptance_probes', 'images', 'cassandra') == generated.fetch('cassandra_image_digest') &&
    coverage.dig('acceptance_probes', 'images', 'opensearch_probe') == generated.fetch('cassandra_image_digest')
  abort 'acceptance probe image roles are missing' unless coverage.dig('acceptance_probes', 'status') == 'ready' &&
    coverage.dig('acceptance_probes', 'images', 'clickhouse') == generated.fetch('clickhouse_image_digest') &&
    coverage.dig('acceptance_probes', 'images', 'tenant_membership_readback') == generated.fetch('deployment_image_digests').fetch('tenant-control-plane')

  first = runtime.first
  runtime_file = File.join(runtime_artifacts, "#{first}.json")
  runtime_original = File.read(runtime_file)
  runtime_cases = {
    'wrong commit' => runtime_original.gsub(revision, 'd' * 40),
    'mutable tag' => runtime_original.gsub(/@sha256:[b]{64}/, ':latest'),
    'other repository' => runtime_original.gsub('ghcr.io/pahuldeepp/grainguard/', 'ghcr.io/untrusted/'),
    'wrong service' => runtime_original.gsub(%("service":"#{first}"), '"service":"other"')
  }
  runtime_cases.each do |name, payload|
    File.write(runtime_file, payload)
    rejected = File.join(directory, name.tr(' ', '-'))
    abort "runtime #{name}: invalid input accepted" if system(*args.map { |arg| arg == output ? rejected : arg }, out: File::NULL, err: File::NULL)
    abort "runtime #{name}: wrote output" if File.exist?(rejected)
  end
  File.write(runtime_file, runtime_original)
  synthetic_file = File.join(runtime_artifacts, 'ml-scoring-synthetic.json')
  synthetic_original = File.read(synthetic_file)
  File.unlink(synthetic_file)
  rejected = File.join(directory, 'missing-synthetic-scorer')
  abort 'missing synthetic scorer accepted' if system(*args.map { |arg| arg == output ? rejected : arg }, out: File::NULL, err: File::NULL)
  File.write(synthetic_file, synthetic_original)
  File.write(synthetic_file, synthetic_original.gsub('ghcr.io/pahuldeepp/grainguard/', 'ghcr.io/untrusted/'))
  rejected = File.join(directory, 'wrong-synthetic-repository')
  abort 'wrong synthetic scorer repository accepted' if system(*args.map { |arg| arg == output ? rejected : arg }, out: File::NULL, err: File::NULL)
  File.write(synthetic_file, synthetic_original)
  File.unlink(runtime_file)
  rejected = File.join(directory, 'missing-runtime')
  abort 'missing runtime image accepted' if system(*args.map { |arg| arg == output ? rejected : arg }, out: File::NULL, err: File::NULL)
  File.write(synthetic_file, synthetic_original)

  # Independently prove migration artifacts are exact: missing artifact,
  # wrong key, mutable tag, wrong repository and wrong revision all reject.
  File.write(runtime_file, runtime_original)
  migration_file = File.join(migration_artifacts, 'migration-control.json')
  migration_original = File.read(migration_file)
  migration_cases = {
    'wrong revision' => migration_original.gsub(revision, 'd' * 40),
    'mutable tag' => migration_original.gsub(/@sha256:[c]{64}/, ':latest'),
    'wrong repository' => migration_original.gsub('/migration-control@', '/control@'),
    'wrong owner' => migration_original.gsub('"service":"control"', '"service":"billing"')
  }
  migration_cases.each do |name, payload|
    File.write(migration_file, payload)
    rejected = File.join(directory, "migration-#{name.tr(' ', '-')}")
    abort "migration #{name}: invalid input accepted" if system(*args.map { |arg| arg == output ? rejected : arg }, out: File::NULL, err: File::NULL)
    abort "migration #{name}: wrote output" if File.exist?(rejected)
  end
  File.write(migration_file, migration_original)
  File.unlink(migration_file)
  rejected = File.join(directory, 'missing-migration')
  abort 'missing owner migration image accepted' if system(*args.map { |arg| arg == output ? rejected : arg }, out: File::NULL, err: File::NULL)

  platform_file = File.join(platform_artifacts, 'opensearch.json')
  platform_original = File.read(platform_file)
  File.write(platform_file, platform_original.gsub('sha256:', 'sha256:bad'))
  rejected = File.join(directory, 'changed-platform-digest')
  abort 'changed platform digest accepted' if system(*args.map { |arg| arg == output ? rejected : arg }, out: File::NULL, err: File::NULL)
  File.write(platform_file, platform_original)
  File.unlink(platform_file)
  rejected = File.join(directory, 'missing-platform-image')
  abort 'missing platform image accepted' if system(*args.map { |arg| arg == output ? rejected : arg }, out: File::NULL, err: File::NULL)
end
puts "CI digest assembler: #{runtime.length} runtime, #{owners.length} owner migrations, 2 tools and #{platform_inventory.fetch('images').length} platform images; exact contracts and fail-closed coverage verified."
