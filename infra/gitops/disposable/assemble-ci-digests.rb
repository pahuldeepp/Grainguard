#!/usr/bin/env ruby
# Assemble only digests signed and verified by the publish matrix. Produces a
# reviewable Terraform input artifact; this script never applies it to AWS.
require 'json'
require 'fileutils'

abort 'usage: assemble-ci-digests.rb RUNTIME_ARTIFACT_DIRECTORY MIGRATION_ARTIFACT_DIRECTORY COMMIT_SHA OUTPUT_DIRECTORY' unless ARGV.length == 4
artifact_dir, migration_artifact_dir, revision, output_dir = ARGV
abort 'revision must be a full Git commit SHA' unless revision.match?(/\A[a-f0-9]{40}\z/)
abort 'output directory already exists' if File.exist?(output_dir)
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
names = contract.fetch('releases').map { |release| release.fetch('image') }.uniq.sort
files = Dir.glob(File.join(artifact_dir, '*.json')).sort
abort 'digest artifact inventory mismatch' unless files.map { |file| File.basename(file, '.json') }.sort == names

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
images = verified_artifacts(files, revision, source_repositories: names, keys_by_repository: runtime_keys,
                            description: 'runtime')

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

FileUtils.mkdir_p(output_dir)
File.write(File.join(output_dir, 'images.json'), JSON.pretty_generate(images) + "\n")
File.write(File.join(output_dir, 'migration-images.json'), JSON.pretty_generate(migration_images) + "\n")
File.write(File.join(output_dir, 'release-inputs.tfvars.json'), JSON.pretty_generate({
  'gitops_revision' => revision,
  'deployment_image_digests' => images,
  'migration_image_digests' => migration_images,
  'migration_gate_image_digest' => tools.fetch('migration-gate'),
  'migration_sql_image_digest' => tools.fetch('migration-sql')
}) + "\n")
puts "Assembled #{images.length} runtime, #{migration_images.length} owner migration, and #{tools.length} migration tool digests for #{revision}."
