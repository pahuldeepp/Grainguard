#!/usr/bin/env ruby
require 'json'
require 'tmpdir'
require 'yaml'

resolver = File.join(__dir__, 'resolve-images.rb')
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
images = contract.fetch('releases').map { |release| release.fetch('image') }.uniq
valid = images.to_h { |image| [image, "123456789012.dkr.ecr.us-east-1.amazonaws.com/greenguard/#{image}@sha256:#{'a' * 64}"] }
Dir.mktmpdir('greenguard-images-') do |dir|
  manifest = File.join(dir, 'manifest.json')
  output = File.join(dir, 'values')
  File.write(manifest, JSON.generate(valid))
  abort 'valid image manifest rejected' unless system('ruby', resolver, manifest, output, out: File::NULL)
  releases = contract.fetch('releases')
  abort 'release count mismatch' unless Dir.glob(File.join(output, '*.yaml')).length == releases.length
  releases.each do |release|
    rendered = YAML.safe_load_file(File.join(output, "#{release.fetch('name')}.yaml"))
    abort "#{release.fetch('name')}: image mismatch" unless rendered.fetch('image') == valid.fetch(release.fetch('image'))
  end
  invalid = {
    'missing image' => valid.reject { |name, _| name == images.first },
    'extra image' => valid.merge('unknown' => valid.fetch(images.first)),
    'mutable tag' => valid.merge(images.first => 'example.com/greenguard:latest'),
    'invalid digest' => valid.merge(images.first => "example.com/greenguard@sha256:#{'g' * 64}")
  }
  invalid.each do |case_name, payload|
    File.write(manifest, JSON.generate(payload))
    rejected = File.join(dir, case_name.tr(' ', '-'))
    abort "#{case_name}: rejected manifest created output" if system('ruby', resolver, manifest, rejected, out: File::NULL, err: File::NULL) || File.exist?(rejected)
  end
end
puts "Image resolver: valid #{images.length}-image/#{contract.fetch('releases').length}-release mapping and four reject cases passed."
