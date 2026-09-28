#!/usr/bin/env ruby
# Structural gate for controller bootstrap. It deliberately performs no install.
require 'json'
require 'yaml'
require 'digest'
require 'open3'

abort 'usage: check-controllers.rb [--ready]' unless ARGV.empty? || ARGV == ['--ready']
directory = __dir__
data = JSON.parse(File.read(File.join(directory, 'controllers.json')))
abort 'unsupported controller schema' unless data.fetch('schemaVersion') == 1
controllers = data.fetch('order')
archive_dir = File.expand_path('../../helm/controller-charts', directory)
lock = JSON.parse(File.read(File.join(archive_dir, 'lock.json')))
abort 'unsupported controller archive lock' unless lock.fetch('schemaVersion') == 1
archives = lock.fetch('archives').to_h { |entry| [entry.fetch('name'), entry] }
expected = %w[aws-load-balancer-controller istio-base istiod istio-ingressgateway keda argo-rollouts argocd]
names = controllers.map { |controller| controller.fetch('name') }
abort 'controller order drifted' unless names == expected
abort 'duplicate controller' unless names.uniq == names
abort 'controller archive inventory drifted' unless archives.keys.sort == names.sort
abort 'unexpected controller archive' unless Dir.glob(File.join(archive_dir, '*.tgz')).map { |path| File.basename(path) }.sort == archives.values.map { |entry| entry.fetch('file') }.sort
controllers.each do |controller|
  abort "#{controller['name']}: missing namespace" unless controller.fetch('namespace').match?(/\A[a-z0-9-]+\z/)
  abort "#{controller['name']}: missing chart" unless controller.fetch('chart').match?(/\A[a-z0-9-]+\z/)
  abort "#{controller['name']}: no prerequisites" if controller.fetch('requires').empty?
  archive = archives.fetch(controller.fetch('name'))
  abort "#{controller['name']}: archive version drift" unless archive.fetch('version') == controller.fetch('version')
  abort "#{controller['name']}: archive source must use HTTPS" unless archive.fetch('source').start_with?('https://')
  path = File.join(archive_dir, archive.fetch('file'))
  abort "#{controller['name']}: archive hash drift" unless File.file?(path) && Digest::SHA256.file(path).hexdigest == archive.fetch('sha256')
  metadata, error, status = Open3.capture3('helm', 'show', 'chart', path)
  abort "#{controller['name']}: archive unreadable: #{error}" unless status.success?
  chart = YAML.safe_load(metadata)
  abort "#{controller['name']}: archive metadata drift" unless chart.fetch('name') == controller.fetch('chart') && chart.fetch('version') == controller.fetch('version')
end
abort 'missing load balancer controller values' unless File.file?(File.join(directory, 'aws-load-balancer-controller-values.yaml'))
terraform = File.read(File.join(directory, '../../terraform/disposable/controllers.tf'))
releases = terraform.scan(/^resource "helm_release" "([^"]+)" \{(.*?)^\}/m).to_h
controllers.each do |controller|
  resource_name = controller.fetch('name').tr('-', '_')
  release = releases[resource_name]
  abort "#{controller['name']}: missing Terraform Helm release" unless release
  actual_version = release[/^\s*version\s*=\s*"([^"]+)"/, 1]
  abort "#{controller['name']}: Terraform chart version drift" unless actual_version == controller.fetch('version')
  expected_path = "${path.module}/../../helm/controller-charts/#{archives.fetch(controller.fetch('name')).fetch('file')}"
  actual_path = release[/^\s*chart\s*=\s*"([^"]+)"/, 1]
  abort "#{controller['name']}: Terraform chart path drift" unless actual_path == expected_path
  abort "#{controller['name']}: remote repository bypasses the archive lock" if release.match?(/^\s*repository\s*=/)
end
abort 'Terraform does not own Argo CD release' unless terraform.include?('resource "helm_release" "argocd"')
teardown = File.read(File.join(directory, '../../terraform/disposable/teardown.tf'))
abort 'controller cleanup missing from destroy graph' unless teardown.include?('helm_release.argocd')
puts "Controller inventory valid: #{controllers.length} ordered releases."
if ARGV == ['--ready']
  unpinned = controllers.reject { |controller| controller['version'].is_a?(String) && controller['version'].match?(/\A\d+\.\d+\.\d+\z/) }
  abort "Controller bootstrap blocked: pin chart versions for #{unpinned.map { |controller| controller['name'] }.join(', ')}" unless unpinned.empty?
  abort 'Controller bootstrap blocked: pinned archive hashes pass, but live CRD/webhook/application health and cluster preflight remain unproven'
end
