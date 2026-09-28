#!/usr/bin/env ruby
require 'json'
require 'tmpdir'
require 'fileutils'

script = File.join(__dir__, 'promote-images-to-ecr.rb')
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
services = contract.fetch('releases').map { |release| release.fetch('image') }.uniq
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
  source = services.to_h { |name| [name, "ghcr.io/pahuldeepp/grainguard/#{name}@#{digest}"] }
  repositories = services.to_h { |name| [name, "#{registry}/greenguard/#{name}"] }
  File.write(inputs, JSON.generate('gitops_revision' => revision, 'deployment_image_digests' => source))
  File.write(urls, JSON.generate(repositories))
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
  expected = services.to_h { |name| [name, "#{registry}/greenguard/#{name}@#{digest}"] }
  abort 'ECR manifest mismatch' unless promoted.fetch('deployment_image_digests') == expected
  calls = File.read(log)
  abort 'signature verification missing' unless calls.scan(/^cosign verify /).length == services.length
  abort 'multi-architecture digest preservation missing' unless calls.scan(/^skopeo copy --all --preserve-digests /).length == services.length
  abort 'ECR digest lookup missing' unless calls.scan(/^aws ecr describe-images /).length == services.length

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

  File.write(urls, JSON.generate(repositories.merge(services.first => "999999999999.dkr.ecr.#{region}.amazonaws.com/greenguard/#{services.first}")))
  succeeded, output = run.call('foreign-repository')
  abort 'foreign ECR repository accepted' if succeeded || File.exist?(output)
end
puts "ECR promotion: #{services.length} signed digest copies and four rejection cases passed offline."
