#!/usr/bin/env ruby
require 'json'
require 'tmpdir'
require 'fileutils'

assembler = File.join(__dir__, 'assemble-ci-digests.rb')
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
images = contract.fetch('releases').map { |release| release.fetch('image') }.uniq
revision = 'a' * 40

Dir.mktmpdir('greenguard-ci-digests-') do |directory|
  artifacts = File.join(directory, 'artifacts')
  FileUtils.mkdir_p(artifacts)
  images.each do |service|
    entry = {
      'service' => service,
      'image' => "ghcr.io/pahuldeepp/grainguard/#{service}@sha256:#{'b' * 64}",
      'revision' => revision
    }
    File.write(File.join(artifacts, "#{service}.json"), JSON.generate(entry))
  end
  output = File.join(directory, 'valid')
  abort 'valid release digests rejected' unless system('ruby', assembler, artifacts, revision, output, out: File::NULL)
  generated = JSON.parse(File.read(File.join(output, 'release-inputs.tfvars.json')))
  abort 'revision mismatch' unless generated.fetch('gitops_revision') == revision
  abort 'image inventory mismatch' unless generated.fetch('deployment_image_digests').keys.sort == images.sort
  abort 'raw image manifest mismatch' unless JSON.parse(File.read(File.join(output, 'images.json'))) == generated.fetch('deployment_image_digests')

  first = images.first
  source = File.join(artifacts, "#{first}.json")
  original = File.read(source)
  cases = {
    'wrong commit' => original.gsub(revision, 'c' * 40),
    'mutable tag' => original.gsub(/@sha256:[b]{64}/, ':latest'),
    'other repository' => original.gsub('ghcr.io/pahuldeepp/grainguard/', 'ghcr.io/untrusted/'),
    'wrong service' => original.gsub(%("service":"#{first}"), '"service":"other"')
  }
  cases.each do |name, payload|
    File.write(source, payload)
    rejected = File.join(directory, name.tr(' ', '-'))
    abort "#{name}: invalid input accepted" if system('ruby', assembler, artifacts, revision, rejected, out: File::NULL, err: File::NULL)
    abort "#{name}: wrote output" if File.exist?(rejected)
  end
  File.write(source, original)
  File.unlink(source)
  abort 'missing service accepted' if system('ruby', assembler, artifacts, revision, File.join(directory, 'missing'), out: File::NULL, err: File::NULL)
end
puts "CI digest assembler: #{images.length} images and five rejection cases passed."
