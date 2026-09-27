#!/usr/bin/env ruby
# Resolve one immutable image per published runtime into per-release Helm values.
require 'json'
require 'yaml'
require 'fileutils'

abort 'usage: resolve-images.rb MANIFEST.json OUTPUT_DIRECTORY' unless ARGV.length == 2
manifest_path, output_dir = ARGV
abort 'output directory already exists' if File.exist?(output_dir)
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
manifest = JSON.parse(File.read(manifest_path))
abort 'image manifest must be a JSON object' unless manifest.is_a?(Hash)
images = contract.fetch('releases').map { |release| release.fetch('image') }.uniq
abort "image inventory mismatch: expected #{images.sort.join(', ')}" unless manifest.keys.sort == images.sort
manifest.each do |name, reference|
  unless reference.is_a?(String) && reference.match?(/\A(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9._\/-]+@sha256:[a-f0-9]{64}\z/) && !reference.include?('//')
    abort "#{name}: image must be an immutable OCI digest reference"
  end
end
FileUtils.mkdir_p(output_dir)
contract.fetch('releases').each do |release|
  File.write(File.join(output_dir, "#{release.fetch('name')}.yaml"), { 'image' => manifest.fetch(release.fetch('image')) }.to_yaml)
end
puts "Resolved #{images.length} immutable images into #{contract.fetch('releases').length} release value files."
