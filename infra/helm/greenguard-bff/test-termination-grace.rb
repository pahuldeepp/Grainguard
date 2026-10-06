#!/usr/bin/env ruby
require 'open3'
require 'yaml'
chart = File.expand_path(__dir__)
image = 'example@sha256:' + 'a' * 64
[340000, 330000, 900000].each do |grace|
  text, error, status = Open3.capture3('helm', 'template', 'test', chart, '--set', "image=#{image}", '--set', "terminationGraceMilliseconds=#{grace}")
  abort error unless status.success?
  deployment = YAML.load_stream(text).compact.find { |d| d['kind'] == 'Deployment' }
  pod = deployment.fetch('spec').fetch('template').fetch('spec')
  abort 'pod grace mismatch' unless pod['terminationGracePeriodSeconds'] == grace / 1000 + 11
  env = pod['containers'].first.fetch('env').find { |e| e['name'] == 'BFF_TERMINATION_GRACE_MS' }
  abort 'application grace mismatch' unless env['value'] == grace.to_s
end
[329999, 900001].each do |grace|
  _, _, status = Open3.capture3('helm', 'template', 'test', chart, '--set', "image=#{image}", '--set', "terminationGraceMilliseconds=#{grace}")
  abort 'invalid grace rendered' if status.success?
end
puts 'BFF termination grace chart tests passed'
