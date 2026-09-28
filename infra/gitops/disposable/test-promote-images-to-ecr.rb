#!/usr/bin/env ruby
require 'json'
require 'tmpdir'
require 'fileutils'

script = File.join(__dir__, 'promote-images-to-ecr.rb')
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
services = contract.fetch('releases').map { |release| release.fetch('image') }.uniq.sort
owners = JSON.parse(File.read(File.join(__dir__, 'owner-migration-inventory.json'))).map { |owner| owner.fetch('name') }.sort
repositories = (services + owners.map { |owner| "migration-#{owner}" } + %w[migration-gate migration-sql]).sort
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
  urls = File.join(directory, 'ecr-urls.json')
  cell = File.join(directory, 'cell.json')
  deployment = services.to_h { |name| [name, "ghcr.io/pahuldeepp/grainguard/#{name}@#{digest}"] }
  migration = owners.to_h { |name| [name, "ghcr.io/pahuldeepp/grainguard/migration-#{name}@#{digest}"] }
  tools = %w[migration-gate migration-sql].to_h { |name| [name, "ghcr.io/pahuldeepp/grainguard/#{name}@#{digest}"] }
  File.write(inputs, JSON.generate({
    'gitops_revision' => revision,
    'deployment_image_digests' => deployment,
    'migration_image_digests' => migration,
    'migration_gate_image_digest' => tools.fetch('migration-gate'),
    'migration_sql_image_digest' => tools.fetch('migration-sql')
  }))
  repositories_by_name = repositories.to_h { |name| [name, "#{registry}/greenguard/#{name}"] }
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
    [system(environment, 'ruby', script, inputs, urls, cell, output, out: File::NULL, err: File::NULL), output]
  end

  succeeded, output = run.call('valid')
  abort 'valid promotion rejected' unless succeeded
  promoted = JSON.parse(File.read(File.join(output, 'release-inputs.tfvars.json')))
  expected_deployment = services.to_h { |name| [name, "#{registry}/greenguard/#{name}@#{digest}"] }
  expected_migration = owners.to_h { |name| [name, "#{registry}/greenguard/migration-#{name}@#{digest}"] }
  abort 'ECR runtime manifest mismatch' unless promoted.fetch('deployment_image_digests') == expected_deployment
  abort 'ECR owner migration manifest mismatch' unless promoted.fetch('migration_image_digests') == expected_migration
  abort 'ECR kubectl image mismatch' unless promoted.fetch('migration_gate_image_digest') == "#{registry}/greenguard/migration-gate@#{digest}"
  abort 'ECR PostgreSQL image mismatch' unless promoted.fetch('migration_sql_image_digest') == "#{registry}/greenguard/migration-sql@#{digest}"
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

  File.write(urls, JSON.generate(repositories_by_name.merge('migration-control' => "999999999999.dkr.ecr.#{region}.amazonaws.com/greenguard/migration-control")))
  succeeded, output = run.call('foreign-repository')
  abort 'foreign repository accepted' if succeeded || File.exist?(output)

  File.write(urls, JSON.generate(repositories_by_name))
  File.write(inputs, JSON.generate({
    'gitops_revision' => revision, 'deployment_image_digests' => deployment,
    'migration_image_digests' => migration.reject { |name, _| name == 'risk' },
    'migration_gate_image_digest' => tools.fetch('migration-gate'),
    'migration_sql_image_digest' => tools.fetch('migration-sql')
  }))
  succeeded, output = run.call('missing-migration')
  abort 'missing owner migration accepted' if succeeded || File.exist?(output)
end
puts "ECR promotion: #{services.length} runtime, #{owners.length} owner migrations and 2 tool digests; signatures, exact digests and fail-closed inventories passed offline."
