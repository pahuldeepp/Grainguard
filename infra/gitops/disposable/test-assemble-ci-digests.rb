#!/usr/bin/env ruby
require 'json'
require 'tmpdir'
require 'fileutils'

assembler = File.join(__dir__, 'assemble-ci-digests.rb')
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
owners = JSON.parse(File.read(File.join(__dir__, 'owner-migration-inventory.json'))).map { |entry| entry.fetch('name') }
runtime = contract.fetch('releases').map { |release| release.fetch('image') }.uniq
migration_repositories = owners.to_h { |owner| ["migration-#{owner}", owner] }.merge(
  'migration-gate' => 'migration-gate', 'migration-sql' => 'migration-sql')
revision = 'a' * 40

Dir.mktmpdir('greenguard-ci-digests-') do |directory|
  runtime_artifacts = File.join(directory, 'runtime')
  migration_artifacts = File.join(directory, 'migration')
  FileUtils.mkdir_p([runtime_artifacts, migration_artifacts])
  runtime.each do |service|
    entry = {'service' => service, 'image' => "ghcr.io/pahuldeepp/grainguard/#{service}@sha256:#{'b' * 64}", 'revision' => revision}
    File.write(File.join(runtime_artifacts, "#{service}.json"), JSON.generate(entry))
  end
  migration_repositories.each do |repository, service|
    entry = {'service' => service, 'image' => "ghcr.io/pahuldeepp/grainguard/#{repository}@sha256:#{'c' * 64}", 'revision' => revision}
    File.write(File.join(migration_artifacts, "#{repository}.json"), JSON.generate(entry))
  end
  output = File.join(directory, 'valid')
  args = ['ruby', assembler, runtime_artifacts, migration_artifacts, revision, output]
  abort 'valid digest artifacts rejected' unless system(*args, out: File::NULL, err: File::NULL)
  generated = JSON.parse(File.read(File.join(output, 'release-inputs.tfvars.json')))
  abort 'revision mismatch' unless generated.fetch('gitops_revision') == revision
  abort 'runtime inventory mismatch' unless generated.fetch('deployment_image_digests').keys.sort == runtime.sort
  abort 'owner migration inventory mismatch' unless generated.fetch('migration_image_digests').keys.sort == owners.sort
  abort 'kubectl tool digest missing' unless generated.fetch('migration_gate_image_digest') == "ghcr.io/pahuldeepp/grainguard/migration-gate@sha256:#{'c' * 64}"
  abort 'PostgreSQL tool digest missing' unless generated.fetch('migration_sql_image_digest') == "ghcr.io/pahuldeepp/grainguard/migration-sql@sha256:#{'c' * 64}"
  abort 'runtime image manifest mismatch' unless JSON.parse(File.read(File.join(output, 'images.json'))) == generated.fetch('deployment_image_digests')
  abort 'migration image manifest mismatch' unless JSON.parse(File.read(File.join(output, 'migration-images.json'))) == generated.fetch('migration_image_digests')

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
  File.unlink(runtime_file)
  rejected = File.join(directory, 'missing-runtime')
  abort 'missing runtime image accepted' if system(*args.map { |arg| arg == output ? rejected : arg }, out: File::NULL, err: File::NULL)

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
end
puts "CI digest assembler: #{runtime.length} runtime, #{owners.length} migration and 2 tool images; exact revision/repository inventories verified."
