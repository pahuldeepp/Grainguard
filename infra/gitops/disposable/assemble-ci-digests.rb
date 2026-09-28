#!/usr/bin/env ruby
# Assemble only digests signed and verified by the publish matrix. Produces a
# reviewable Terraform input artifact; this script never applies it to AWS.
require 'json'
require 'fileutils'

abort 'usage: assemble-ci-digests.rb ARTIFACT_DIRECTORY COMMIT_SHA OUTPUT_DIRECTORY' unless ARGV.length == 3
artifact_dir, revision, output_dir = ARGV
abort 'revision must be a full Git commit SHA' unless revision.match?(/\A[a-f0-9]{40}\z/)
abort 'output directory already exists' if File.exist?(output_dir)
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
names = contract.fetch('releases').map { |release| release.fetch('image') }.uniq.sort
files = Dir.glob(File.join(artifact_dir, '*.json')).sort
abort 'digest artifact inventory mismatch' unless files.map { |file| File.basename(file, '.json') }.sort == names

images = files.to_h do |file|
  entry = JSON.parse(File.read(file))
  abort "#{file}: invalid digest artifact" unless entry.is_a?(Hash) && entry.keys.sort == %w[image revision service]
  service = File.basename(file, '.json')
  image = entry.fetch('image')
  expected = "ghcr.io/pahuldeepp/grainguard/#{service}@sha256:"
  abort "#{service}: digest artifact does not match the signed commit and image" unless
    entry.fetch('service') == service && entry.fetch('revision') == revision &&
    image.is_a?(String) && image.start_with?(expected) &&
    image.delete_prefix(expected).match?(/\A[a-f0-9]{64}\z/)
  [service, image]
end

FileUtils.mkdir_p(output_dir)
File.write(File.join(output_dir, 'images.json'), JSON.pretty_generate(images) + "\n")
File.write(File.join(output_dir, 'release-inputs.tfvars.json'), JSON.pretty_generate({
  'gitops_revision' => revision,
  'deployment_image_digests' => images
}) + "\n")
puts "Assembled #{images.length} verified image digests for #{revision}."
