#!/usr/bin/env ruby
# Reverify signed GHCR images, copy every architecture without changing its
# digest, then emit the Terraform input using this cell's ECR references.
require 'json'
require 'fileutils'
require 'open3'
require 'tempfile'

abort 'usage: promote-images-to-ecr.rb RELEASE_INPUTS_JSON ECR_URLS_JSON CELL_IDENTITY_JSON OUTPUT_DIRECTORY' unless ARGV.length == 4
inputs_path, urls_path, identity_path, output_dir = ARGV
abort 'output directory already exists' if File.exist?(output_dir)
inputs = JSON.parse(File.read(inputs_path))
urls = JSON.parse(File.read(urls_path))
cell = JSON.parse(File.read(identity_path))
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
services = contract.fetch('releases').map { |release| release.fetch('image') }.uniq.sort
owners = JSON.parse(File.read(File.join(__dir__, 'owner-migration-inventory.json'))).map { |owner| owner.fetch('name') }.sort
tool_repositories = %w[migration-gate migration-sql]
expected_fields = %w[deployment_image_digests gitops_revision migration_gate_image_digest migration_image_digests migration_sql_image_digest]
abort 'invalid release inputs' unless inputs.is_a?(Hash) && inputs.keys.sort == expected_fields
revision = inputs.fetch('gitops_revision')
abort 'revision must be a full Git commit SHA' unless revision.is_a?(String) && revision.match?(/\A[a-f0-9]{40}\z/)
migration_source = inputs.fetch('migration_image_digests')
abort 'owner migration image inventory mismatch' unless migration_source.is_a?(Hash) && migration_source.keys.sort == owners
source = inputs.fetch('deployment_image_digests')
abort 'runtime image inventory mismatch' unless source.is_a?(Hash) && source.keys.sort == services
tool_source = {
  'migration-gate' => inputs.fetch('migration_gate_image_digest'),
  'migration-sql' => inputs.fetch('migration_sql_image_digest')
}
all_repositories = services + owners.map { |owner| "migration-#{owner}" } + tool_repositories
abort 'ECR repository inventory mismatch' unless urls.is_a?(Hash) && urls.keys.sort == all_repositories.sort
abort 'invalid Terraform cell identity' unless cell.is_a?(Hash) && cell.keys.sort == %w[account_id cluster_name environment region]
account = cell.fetch('account_id')
region = cell.fetch('region')
abort 'invalid Terraform account or region' unless account.is_a?(String) && account.match?(/\A[0-9]{12}\z/) &&
  region.is_a?(String) && region.match?(/\A[a-z]{2}-[a-z]+-[0-9]+\z/)
registry = "#{account}.dkr.ecr.#{region}.amazonaws.com"
references = {}
services.each { |service| references[service] = source.fetch(service) }
owners.each { |owner| references["migration-#{owner}"] = migration_source.fetch(owner) }
tool_source.each { |repository, reference| references[repository] = reference }
references.each do |repository, reference|
  expected_source = "ghcr.io/pahuldeepp/grainguard/#{repository}@sha256:"
  abort "#{repository}: source must be the signed GHCR digest" unless reference.is_a?(String) &&
    reference.start_with?(expected_source) && reference.delete_prefix(expected_source).match?(/\A[a-f0-9]{64}\z/)
  abort "#{repository}: ECR URL does not match this Terraform cell" unless
    urls.fetch(repository) == "#{registry}/greenguard/#{repository}"
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
    details = JSON.parse(command('aws', 'ecr', 'describe-images', '--region', region,
                                 '--repository-name', "greenguard/#{repository}",
                                 '--image-ids', "imageTag=sha-#{revision}", '--output', 'json'))
    digest = details.fetch('imageDetails').fetch(0).fetch('imageDigest')
    abort "#{repository}: ECR digest changed during promotion" unless digest == reference.split('@').last
    destination[repository] = "#{urls.fetch(repository)}@#{digest}"
  end
end

deployment_destination = services.to_h { |service| [service, destination.fetch(service)] }
migration_destination = owners.to_h { |owner| [owner, destination.fetch("migration-#{owner}")] }

FileUtils.mkdir_p(output_dir)
File.write(File.join(output_dir, 'release-inputs.tfvars.json'), JSON.pretty_generate({
  'gitops_revision' => revision,
  'deployment_image_digests' => deployment_destination,
  'migration_image_digests' => migration_destination,
  'migration_gate_image_digest' => destination.fetch('migration-gate'),
  'migration_sql_image_digest' => destination.fetch('migration-sql')
}) + "\n")
File.write(File.join(output_dir, 'images.json'), JSON.pretty_generate(deployment_destination) + "\n")
File.write(File.join(output_dir, 'migration-images.json'), JSON.pretty_generate(migration_destination) + "\n")
puts "Promoted #{services.length} runtime, #{owners.length} owner migration and #{tool_source.length} tool image digests into #{registry}."
