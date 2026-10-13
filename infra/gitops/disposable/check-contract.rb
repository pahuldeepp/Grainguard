#!/usr/bin/env ruby
# Offline deployment-contract check. Passing does not deploy or independently
# attest a live AWS environment.
require 'digest'
require 'json'
require 'pathname'
require 'time'
require 'yaml'

module DisposableContract
  EXPECTED_IMAGES = %w[
    dashboard bff gateway device-service read-api workflow-alerts telemetry-ingest
    cdc-transformer projection-builder cache-invalidator risk-engine hardware-service
    eventbridge-bridge saga-orchestrator tenant-control-plane billing-service
    notification-service jobs-worker cassandra-writer search-indexer telemetry-sinks
  ].freeze
  CHARTS = %w[greenguard-dashboard greenguard-bff greenguard-service].freeze

  module_function

  def required_acceptance_ids(contract)
    acceptance = contract.fetch('phases').find { |phase| phase.fetch('id') == 'acceptance' }
    ids = acceptance.fetch('probes') + acceptance.fetch('journeys')
    raise 'acceptance probe and journey IDs must be unique nonempty strings' unless
      ids.all? { |id| id.is_a?(String) && !id.empty? } && ids.uniq == ids

    ids
  end

  def evidence_failures(manifest_path, contract, evidence_root)
    manifest = JSON.parse(File.read(manifest_path))
    failures = []
    failures << 'schemaVersion must be 1' unless manifest.is_a?(Hash) && manifest['schemaVersion'] == 1
    return failures unless manifest.is_a?(Hash)

    scope = manifest['scope']
    unless scope.is_a?(Hash)
      return failures << 'scope must be an object'
    end
    scope_rules = {
      'accountId' => /\A[0-9]{12}\z/,
      'region' => /\A[a-z]{2}-[a-z]+-[0-9]+\z/,
      'cluster' => /\A[a-z0-9][a-z0-9-]{2,99}\z/,
      'gitRevision' => /\A[a-f0-9]{40}\z/
    }
    scope_rules.each do |field, pattern|
      failures << "scope.#{field} is invalid" unless scope[field].is_a?(String) && pattern.match?(scope[field])
    end
    begin
      raise ArgumentError unless timestamp_with_offset?(scope['startedAt']) && timestamp_with_offset?(scope['endedAt'])
      started = Time.iso8601(scope.fetch('startedAt'))
      ended = Time.iso8601(scope.fetch('endedAt'))
      failures << 'scope time range is reversed' unless started < ended
    rescue KeyError, ArgumentError, TypeError
      failures << 'scope needs valid startedAt and endedAt timestamps with offsets'
      started = ended = nil
    end

    checks = manifest['checks']
    return failures << 'checks must be a list' unless checks.is_a?(Array)
    ids = checks.map { |item| item.is_a?(Hash) ? item['id'] : nil }
    failures << 'checks need unique string IDs' if ids.any? { |id| !id.is_a?(String) } || ids.uniq.length != ids.length
    required_acceptance_ids(contract).each do |id|
      failures << "missing live check: #{id}" unless ids.include?(id)
    end

    evidence_dir = Pathname.new(evidence_root).realpath
    checks.each do |item|
      next unless item.is_a?(Hash)

      id = item['id'].is_a?(String) ? item['id'] : 'unknown'
      failures << "#{id}: live status is not PASS" unless item['status'] == 'PASS'
      %w[expected observation operator].each do |field|
        failures << "#{id}: #{field} required" unless item[field].is_a?(String) && !item[field].strip.empty?
      end
      begin
        raise ArgumentError unless timestamp_with_offset?(item['observedAt'])
        observed = Time.iso8601(item.fetch('observedAt'))
        failures << "#{id}: observation outside run window" if started && ended && !(started..ended).cover?(observed)
      rescue KeyError, ArgumentError, TypeError
        failures << "#{id}: observedAt must be a timestamp with an offset"
      end

      artifacts = item['artifacts']
      if !artifacts.is_a?(Array) || artifacts.empty?
        failures << "#{id}: at least one evidence artifact required"
        next
      end
      artifacts.each do |artifact|
        unless artifact.is_a?(Hash) && artifact['path'].is_a?(String) && artifact['sha256'].is_a?(String) &&
               artifact['sha256'].match?(/\A[a-f0-9]{64}\z/)
          failures << "#{id}: artifact needs a path and SHA-256"
          next
        end
        begin
          # Evidence paths are repository-relative, as in check-live-acceptance.py.
          path = Pathname.new(File.expand_path(artifact['path'], evidence_dir.parent))
          resolved = path.realpath
          relative = resolved.relative_path_from(evidence_dir)
          raise ArgumentError if relative.each_filename.first == '..' || !resolved.file?
          unless Digest::SHA256.file(resolved).hexdigest == artifact['sha256']
            failures << "#{id}: artifact hash mismatch"
          end
        rescue SystemCallError, ArgumentError
          failures << "#{id}: artifact missing or outside evidence directory"
        end
      end
    end
    failures
  rescue JSON::ParserError, SystemCallError => error
    ["invalid evidence manifest (#{error.class})"]
  end

  def timestamp_with_offset?(value)
    value.is_a?(String) && value.match?(/(?:Z|[+-][0-9]{2}:[0-9]{2})\z/)
  end

  def readiness_failures(contract, manifest_path:, evidence_root:)
    gaps = contract.fetch('blockingGaps')
    failures = []
    unless gaps.is_a?(Array) && gaps.all? { |gap| gap.is_a?(String) && !gap.strip.empty? }
      failures << 'blockingGaps must be a list of nonempty strings'
    else
      gaps.each { |gap| failures << "unresolved blocking gap: #{gap}" }
    end
    if manifest_path.nil? || manifest_path.to_s.strip.empty?
      failures << 'explicit acceptance evidence manifest is required'
    else
      failures.concat(evidence_failures(manifest_path, contract, evidence_root))
    end
    failures << 'trusted signed, scope-bound live attestation is unavailable; offline evidence cannot certify deployment readiness'
    failures
  end

  def run(argv = ARGV, root: File.expand_path('../../..', __dir__), contract_path: File.join(__dir__, 'contract.json'))
    valid_args = argv.empty? || argv == ['--ready'] || (argv.length == 2 && %w[--ready --validate-evidence].include?(argv.first))
    unless valid_args
      abort 'usage: check-contract.rb [--ready [acceptance-evidence.json] | --validate-evidence acceptance-evidence.json]'
    end
    contract = JSON.parse(File.read(contract_path))
    abort 'unsupported contract schema' unless contract['schemaVersion'] == 1
    phases = contract.fetch('phases').map { |phase| phase.fetch('id') }
    abort 'unsafe deployment phase order' unless phases == %w[controllers data migrations applications acceptance]
    begin
      required_acceptance_ids(contract)
    rescue KeyError, NoMethodError, TypeError, RuntimeError => error
      abort "invalid acceptance contract: #{error.message}"
    end

    observability_names = %w[otel opentelemetry prometheus grafana tempo loki]
    controller_source = File.read(File.join(root, 'infra/terraform/disposable/controllers.tf'))
    gitops_source = File.read(File.join(root, 'infra/terraform/disposable/gitops.tf'))
    owned_observability = observability_names.all? do |name|
      controller_source.match?(/resource\s+"helm_release"\s+"[^"]*#{name}[^"]*"/) ||
        contract.fetch('releases').any? { |release| release.fetch('name').include?(name) }
    end
    runtime_export_wired = gitops_source.match?(/name\s*=\s*"OTEL_EXPORTER_OTLP_ENDPOINT"/)
    chart_telemetry_enabled = %w[greenguard-service greenguard-bff greenguard-dashboard].all? do |chart|
      values = YAML.safe_load_file(File.join(root, 'infra/helm', chart, 'values.yaml'))
      values.dig('observability', 'prometheus', 'enabled') == true &&
        values.dig('observability', 'collector', 'enabled') == true
    end
    unless owned_observability && runtime_export_wired && chart_telemetry_enabled
      abort 'unowned or unwired Stage 11 observability must remain a blocking gap' unless
        contract.fetch('blockingGaps').any? { |gap| gap.include?('Stage 11 observability') }
    end

    releases = contract.fetch('releases')
    names = releases.map { |release| release.fetch('name') }
    abort 'duplicate release' unless names.uniq == names
    images = releases.map { |release| release.fetch('image') }.uniq
    abort 'published image coverage drifted' unless images.sort == EXPECTED_IMAGES.sort
    releases.each do |release|
      abort "#{release['name']}: invalid phase" unless release.fetch('phase') == 'applications'
      chart = release.fetch('chart')
      abort "#{release['name']}: invalid chart" unless CHARTS.include?(chart)
      chart_path = File.join(root, 'infra/helm', chart)
      abort "#{release['name']}: missing chart" unless File.file?(File.join(chart_path, 'Chart.yaml'))
      if chart == 'greenguard-service'
        profile = release.fetch('profile')
        abort "#{release['name']}: missing profile" unless File.file?(File.join(chart_path, 'values', "#{profile}.yaml"))
      end
      abort "#{release['name']}: missing secret contract" unless release.fetch('secret').match?(/\A[a-z0-9-]+\z/)
    end
    puts "Disposable contract structure valid: #{releases.length} releases, #{images.length} images, #{contract.fetch('blockingGaps').length} blocking gaps."
    return if argv.empty?

    if argv.first == '--validate-evidence'
      abort 'usage: check-contract.rb --validate-evidence acceptance-evidence.json' unless argv.length == 2
      failures = evidence_failures(argv[1], contract, File.join(root, 'evidence'))
      abort failures.join("\n") unless failures.empty?
      puts 'Acceptance evidence structure and artifact hashes are valid. This check is non-certifying and does not establish live behavior or deployment readiness.'
      return
    end

    failures = readiness_failures(contract, manifest_path: argv[1], evidence_root: File.join(root, 'evidence'))
    unless failures.empty?
      warn "Deployment is blocked:\n- #{failures.join("\n- ")}"
      exit 1
    end
    abort 'Deployment is blocked: trusted signed live attestation is unavailable'
  end
end

DisposableContract.run if $PROGRAM_NAME == __FILE__
