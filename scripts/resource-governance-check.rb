#!/usr/bin/env ruby
# Offline chart renders and narrow IaC source/input checks; no cloud operations.
require 'json'
require 'yaml'
require 'open3'
require 'optparse'
require 'tempfile'

ROOT = File.expand_path('..', __dir__)
OPTIONS = { policy: File.join(ROOT, 'infra/governance/local-resource-policy.json') }
OptionParser.new do |parser|
  parser.banner = 'Usage: ruby scripts/resource-governance-check.rb [--policy FILE] [--profile NAME --values FILE] [--terraform-inputs FILE] [--terraform-variables FILE] [--self-test]'
  parser.on('--policy FILE') { |v| OPTIONS[:policy] = v }
  parser.on('--profile NAME') { |v| OPTIONS[:profile] = v }
  parser.on('--values FILE') { |v| OPTIONS[:values] = v }
  parser.on('--terraform-inputs FILE') { |v| OPTIONS[:terraform_inputs] = v }
  parser.on('--terraform-variables FILE') { |v| OPTIONS[:terraform_variables] = v }
  parser.on('--self-test') { OPTIONS[:self_test] = true }
end.parse!

def ensure_rule(condition, message)
  raise message unless condition
end

def integer(value, minimum, maximum, label)
  ensure_rule(value.is_a?(Integer) && value.between?(minimum, maximum), "#{label} must be an integer in #{minimum}..#{maximum}")
end

def quantity(value, resource)
  text = value.to_s
  if resource == 'cpu'
    match = /\A(\d+(?:\.\d+)?)(m?)\z/.match(text)
    ensure_rule(match, "unsupported CPU quantity #{text.inspect}")
    Float(match[1]) * (match[2] == 'm' ? 1 : 1000)
  else
    match = /\A(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti)?\z/.match(text)
    ensure_rule(match, "unsupported memory quantity #{text.inspect}")
    Float(match[1]) * { nil => 1.0 / (1024 * 1024), 'Ki' => 1.0 / 1024, 'Mi' => 1, 'Gi' => 1024, 'Ti' => 1024 * 1024 }.fetch(match[2])
  end
end

def validate_policy(policy)
  %w[maxContainerCpuMillicores maxContainerMemoryMi maxReplicas maxGeneralNodes maxComputeNodes].each do |key|
    integer(policy[key], 1, 1_000_000, "policy #{key}")
  end
  budget = policy.fetch('budget')
  %w[ownerRole escalationRole].each { |key| ensure_rule(budget[key].is_a?(String) && !budget[key].strip.empty?, "budget #{key} required") }
  ratios = %w[warningFraction escalationFraction limitFraction].map { |key| budget.fetch(key) }
  ensure_rule(ratios.all? { |n| n.is_a?(Numeric) && n.finite? && n > 0 } && ratios[0] < ratios[1] && ratios[1] < ratios[2] && ratios[2] <= 1, 'budget thresholds require 0 < warning < escalation < limit <= 1')
  amount = budget['monthlyAmount']
  ensure_rule(amount.nil? || (amount.is_a?(Numeric) && amount.finite? && amount > 0 && budget['currency'].is_a?(String) && budget['currency'].match?(/\A[A-Z]{3}\z/)), 'configured monthly budget requires positive amount and three-letter currency')
end

def profiles
  result = { 'dashboard' => ['greenguard-dashboard', nil], 'bff' => ['greenguard-bff', nil], 'service-default' => ['greenguard-service', nil] }
  Dir.glob(File.join(ROOT, 'infra/helm/greenguard-service/values/*.yaml')).sort.each do |path|
    result[File.basename(path, '.yaml')] = ['greenguard-service', path]
  end
  result
end

def check_profile(name, chart, values, policy, override = nil)
  args = ['helm', 'template', name, File.join(ROOT, 'infra/helm', chart), '--namespace', 'greenguard', '--set-string', "image=example.invalid/local-check@sha256:#{'0' * 64}"]
  args += ['--values', values] if values
  args += ['--values', override] if override
  output, error, status = Open3.capture3(*args)
  ensure_rule(status.success?, "#{name}: Helm rejected configuration: #{error.strip}")
  docs = YAML.load_stream(output).compact
  workloads = docs.select { |doc| %w[Deployment Rollout].include?(doc['kind']) }
  ensure_rule(!workloads.empty?, "#{name}: no workload rendered")
  totals = { cpu: 0, memory: 0 }
  workloads.each do |doc|
    spec = doc.fetch('spec')
    workload_name = doc.fetch('metadata').fetch('name')
    scalers = docs.select { |d| %w[HorizontalPodAutoscaler ScaledObject].include?(d['kind']) && d.dig('spec', 'scaleTargetRef', 'name') == workload_name }
    ensure_rule(scalers.size <= 1, "#{name}: multiple autoscaling owners")
    replicas = if scalers.empty?
                 spec.fetch('replicas')
               else
                 scaler = scalers.first
                 ensure_rule(!spec.key?('replicas'), "#{name}: replicas must be owned by scaler")
                 scale = scaler.fetch('spec')
                 keda = scaler['kind'] == 'ScaledObject'
                 min = scale.fetch(keda ? 'minReplicaCount' : 'minReplicas')
                 max = scale.fetch(keda ? 'maxReplicaCount' : 'maxReplicas')
                 integer(min, keda ? 0 : 1, policy['maxReplicas'], "#{name}: scaling minimum")
                 integer(max, 1, policy['maxReplicas'], "#{name}: scaling maximum")
                 ensure_rule(min <= max, "#{name}: scaling minimum exceeds maximum")
                 max
               end
    integer(replicas, 0, policy['maxReplicas'], "#{name}: replicas")
    pod = spec.fetch('template').fetch('spec')
    # Init containers are checked too; sums below describe steady-state app containers.
    (pod.fetch('containers') + pod.fetch('initContainers', [])).each do |container|
      resources = container.fetch('resources')
      %w[cpu memory].each do |resource|
        request = quantity(resources.fetch('requests').fetch(resource), resource)
        limit = quantity(resources.fetch('limits').fetch(resource), resource)
        cap = policy.fetch(resource == 'cpu' ? 'maxContainerCpuMillicores' : 'maxContainerMemoryMi')
        ensure_rule(request > 0 && limit > 0 && request <= limit && limit <= cap, "#{name}/#{container['name']}: #{resource} requires 0 < request <= limit <= proposed cap #{cap}")
        if pod['containers'].include?(container)
          totals[resource.to_sym] += request * replicas
        end
      end
    end
  end
  puts "PASS #{name}: peak app requests #{totals[:cpu]}m CPU / #{totals[:memory]}Mi memory (excludes sidecars injected at admission, surge and init overlap)"
end

# Deliberately narrow HCL reader: preserve strings, remove comments, track braces,
# and accept only complete integer literals in active top-level variable blocks.
def node_defaults(source, keys)
  clean = source.gsub(/"(?:\\.|[^"\\])*"|\#[^\n]*|\/\/[^\n]*|\/\*.*?\*\//m) do |token|
    token.start_with?('"') ? token : token.gsub(/[^\n]/, ' ')
  end
  ensure_rule(!clean.include?('/*') && !clean.include?('<<'), 'unsupported or unterminated HCL syntax')
  depths = {}
  depth = 0
  clean.to_enum(:scan, /"(?:\\.|[^"\\])*"|[{}]/m).each do
    token = Regexp.last_match
    depths[token.begin(0)] = depth
    depth += 1 if token[0] == '{'
    depth -= 1 if token[0] == '}'
    ensure_rule(depth >= 0, 'unbalanced HCL braces')
  end
  ensure_rule(depth.zero?, 'unbalanced HCL braces')
  keys.to_h do |key|
    headers = clean.to_enum(:scan, /^[ \t]*variable[ \t]+"#{Regexp.escape(key)}"[ \t]*\{/).map { Regexp.last_match }
    headers.select! { |header| depths[header.end(0) - 1] == 0 }
    ensure_rule(headers.size == 1, "#{key}: exactly one active top-level variable block required")
    opening = headers.first.end(0) - 1
    closing = depths.keys.find { |index| index > opening && clean[index] == '}' && depths[index] == 1 }
    ensure_rule(closing, "#{key}: missing closing brace")
    body = clean[(opening + 1)...closing]
    # Inspect only direct children. Continuations/operators on a separate line
    # cannot be ignored after an otherwise valid default literal.
    direct_lines = []
    local_depth = 0
    body.each_line do |line|
      if local_depth.zero? && !line.strip.empty?
        ensure_rule(line.match?(/\A[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*[ \t]*=|[A-Za-z_][A-Za-z0-9_]*[ \t]*\{)/), "#{key}: unsupported HCL attribute continuation")
        direct_lines << line
      end
      line.scan(/"(?:\\.|[^"\\])*"|[{}]/).each do |token|
        local_depth += 1 if token == '{'
        local_depth -= 1 if token == '}'
      end
    end
    defaults = direct_lines.filter_map { |line| line.match(/\A[ \t]*default[ \t]*=[ \t]*(.*?)[ \t]*\n?\z/)&.[](1)&.strip }
    ensure_rule(defaults.size == 1 && defaults.first.match?(/\A[0-9]+\z/), "#{key}: default must be a complete unambiguous integer literal")
    [key, Integer(defaults.first, 10)]
  end
end

def check_terraform(policy, overrides = {}, source = nil)
  source ||= File.read(OPTIONS[:terraform_variables] || File.join(ROOT, 'infra/terraform/platform/variables.tf'))
  keys = %w[general_node_min_size general_node_desired_size general_node_max_size compute_node_max_size]
  ensure_rule((overrides.keys - keys).empty?, 'Terraform inputs support only the four node-size variables; use the actual full tfvars for Terraform separately')
  values = node_defaults(source, keys).merge(overrides)
  keys.each { |key| integer(values[key], 1, policy[key.start_with?('general') ? 'maxGeneralNodes' : 'maxComputeNodes'], key) }
  ensure_rule(values['general_node_min_size'] <= values['general_node_desired_size'] && values['general_node_desired_size'] <= values['general_node_max_size'], 'general node inputs require min <= desired <= max')
  main = File.read(File.join(ROOT, 'infra/terraform/platform/main.tf'))
  %w[general compute].each do |pool|
    body = main.match(/resource\s+"aws_eks_node_group"\s+"#{pool}"\s*\{(.*?)\n\}/m)&.[](1)
    ensure_rule(body, "missing #{pool} node group")
    scaling = body.match(/scaling_config\s*\{([^}]+)\}/m)&.[](1)
    ensure_rule(scaling, "missing #{pool} scaling block")
    expected = pool == 'general' ? { 'min_size' => 'var.general_node_min_size', 'desired_size' => 'var.general_node_desired_size', 'max_size' => 'var.general_node_max_size' } : { 'min_size' => '0', 'desired_size' => '0', 'max_size' => 'var.compute_node_max_size' }
    actual = scaling.lines.filter_map { |line| line.strip.empty? ? nil : line.strip }.sort
    ensure_rule(actual.map { |line| line.gsub(/\s+/, ' ') } == expected.map { |key, value| "#{key} = #{value}" }.sort, "#{pool} scaling wiring changed; review source and checker")
  end
  puts "PASS Terraform static node inputs/wiring: #{values.to_json}; compute min/desired=0 (not Terraform validation/plan)"
end

def reject_case(label)
  begin
    yield
  rescue StandardError => error
    puts "PASS rejection #{label}: #{error.message.lines.first.strip}"
    return
  end
  raise "invalid fixture was accepted: #{label}"
end

begin
  policy = JSON.parse(File.read(OPTIONS[:policy]))
  validate_policy(policy)
  ensure_rule(!OPTIONS[:values] || OPTIONS[:profile], '--values requires --profile')
  selected = profiles
  if OPTIONS[:profile]
    ensure_rule(selected.key?(OPTIONS[:profile]), 'unknown profile')
    selected = { OPTIONS[:profile] => selected.fetch(OPTIONS[:profile]) }
  end
  selected.each { |name, (chart, values)| check_profile(name, chart, values, policy, OPTIONS[:values]) }
  overrides = OPTIONS[:terraform_inputs] ? JSON.parse(File.read(OPTIONS[:terraform_inputs])) : {}
  check_terraform(policy, overrides)
  if OPTIONS[:self_test]
    Tempfile.create(['resource-governance-supported-keda-', '.yaml']) do |file|
      file.write("autoscaling:\n  keda:\n    enabled: true\n    minReplicaCount: 0\n    maxReplicaCount: #{[10, policy['maxReplicas']].min}\n    triggers: [{type: cpu, metricType: Utilization, metadata: {value: '70'}}]\n")
      file.flush
      check_profile('supported-keda', 'greenguard-service', File.join(ROOT, 'infra/helm/greenguard-service/values/hardware-service-worker.yaml'), policy, file.path)
    end
    {
      'request exceeds limit' => "resources:\n  requests: {cpu: 600m, memory: 128Mi}\n  limits: {cpu: 500m, memory: 512Mi}\n",
      'memory cap' => "resources:\n  limits: {cpu: 500m, memory: #{policy['maxContainerMemoryMi'] + 1}Mi}\n",
      'resource cap' => "resources:\n  limits: {cpu: #{policy['maxContainerCpuMillicores'] + 1}m, memory: 512Mi}\n",
      'fixed replica cap' => "replicaCount: #{policy['maxReplicas'] + 1}\n",
      'HPA cap' => "autoscaling:\n  hpa: {enabled: true, maxReplicas: #{policy['maxReplicas'] + 1}}\n",
      'KEDA cap' => "pdb: {enabled: false}\nautoscaling:\n  keda:\n    enabled: true\n    minReplicaCount: 0\n    maxReplicaCount: #{policy['maxReplicas'] + 1}\n    triggers: [{type: cpu, metricType: Utilization, metadata: {value: '70'}}]\n"
    }.each do |label, fixture|
      Tempfile.create(['resource-governance-', '.yaml']) do |file|
        file.write(fixture)
        file.flush
        reject_case(label) { check_profile('fixture', 'greenguard-service', nil, policy, file.path) }
      end
    end
    source = File.read(File.join(ROOT, 'infra/terraform/platform/variables.tf'))
    %w[4.5 4e2].concat(['4 + 10', "4\n    + 10"]).each do |expression|
      fixture = source.sub(/(variable "compute_node_max_size" \{.*?default[ \t]*=[ \t]*)[0-9]+(?=[ \t]*\n)/m) { "#{Regexp.last_match(1)}#{expression}" }
      reject_case("HCL default #{expression.inspect}") { check_terraform(policy, {}, fixture) }
    end
    ['#', '//'].each do |marker|
      fixture = source.sub(/(variable "compute_node_max_size" \{.*?)(default[ \t]*=[ \t]*[0-9]+)(?=[ \t]*\n)/m) { "#{Regexp.last_match(1)}#{marker} #{Regexp.last_match(2)}" }
      reject_case("HCL commented default #{marker}") { check_terraform(policy, {}, fixture) }
    end
    fixture = source.sub(/variable "compute_node_max_size" \{.*?\n\}/m) { "/* #{Regexp.last_match(0)} */" }
    reject_case('HCL commented variable block') { check_terraform(policy, {}, fixture) }
    reject_case('node cap') { check_terraform(policy, { 'compute_node_max_size' => policy['maxComputeNodes'] + 1 }) }
    reject_case('node ordering') { check_terraform(policy, { 'general_node_desired_size' => 1 }) }
    reject_case('budget alert ordering') { validate_policy(policy.merge('budget' => policy['budget'].merge('warningFraction' => 1))) }
  end
  puts 'PASS local governance; budget amount/contacts and cloud billing alerts require operator evidence'
rescue StandardError => error
  warn "FAIL resource governance: #{error.message}"
  exit 1
end
