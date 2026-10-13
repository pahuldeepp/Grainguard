require 'digest'
require 'json'
require 'minitest/autorun'
require 'tmpdir'

require_relative 'check-contract'

class DisposableContractReadinessTest < Minitest::Test
  CONTRACT_PATH = File.join(__dir__, 'contract.json')

  def setup
    @contract = JSON.parse(File.read(CONTRACT_PATH))
    @temporary_directory = Dir.mktmpdir('disposable-contract-readiness')
    @evidence_directory = File.join(@temporary_directory, 'evidence')
    Dir.mkdir(@evidence_directory)
  end

  def teardown
    FileUtils.remove_entry(@temporary_directory)
  end

  def test_current_contract_stays_blocked_and_reports_all_seven_gaps_and_missing_evidence
    assert_equal 7, @contract.fetch('blockingGaps').length

    failures = DisposableContract.readiness_failures(
      @contract,
      manifest_path: nil,
      evidence_root: @evidence_directory
    )

    assert_equal 7, failures.count { |failure| failure.start_with?('unresolved blocking gap:') }
    assert_includes failures, 'explicit acceptance evidence manifest is required'
  end

  def test_invalid_explicit_acceptance_evidence_blocks_even_after_hypothetical_gap_closure
    hypothetical_contract = @contract.merge('blockingGaps' => [])
    manifest_path = File.join(@temporary_directory, 'invalid-evidence.json')
    File.write(manifest_path, '{not-json')

    failures = DisposableContract.readiness_failures(
      hypothetical_contract,
      manifest_path: manifest_path,
      evidence_root: @evidence_directory
    )

    assert failures.any? { |failure| failure.start_with?('invalid evidence manifest') }
  end

  def test_fabricated_pass_prose_and_valid_hash_never_certify_readiness
    hypothetical_contract = @contract.merge('blockingGaps' => [])
    evidence_path = File.join(@evidence_directory, 'acceptance-proof.json')
    File.write(evidence_path, JSON.generate(result: 'pass'))
    relative_evidence_path = 'evidence/acceptance-proof.json'
    evidence_sha256 = Digest::SHA256.file(evidence_path).hexdigest
    started_at = '2026-09-28T10:00:00Z'
    ended_at = '2026-09-28T11:00:00Z'
    observed_at = '2026-09-28T10:30:00Z'
    checks = DisposableContract.required_acceptance_ids(hypothetical_contract).map do |id|
      {
        'id' => id,
        'status' => 'PASS',
        'expected' => 'Acceptance behavior succeeds',
        'observation' => 'Observed expected behavior',
        'operator' => 'test operator',
        'observedAt' => observed_at,
        'artifacts' => [{ 'path' => relative_evidence_path, 'sha256' => evidence_sha256 }]
      }
    end
    manifest_path = File.join(@temporary_directory, 'acceptance-evidence.json')
    File.write(manifest_path, JSON.generate(
      schemaVersion: 1,
      scope: {
        accountId: '123456789012',
        region: 'us-east-1',
        cluster: 'greenguard-disposable',
        gitRevision: 'a' * 40,
        startedAt: started_at,
        endedAt: ended_at
      },
      checks: checks
    ))

    evidence_failures = DisposableContract.evidence_failures(
      manifest_path,
      hypothetical_contract,
      @evidence_directory
    )
    readiness_failures = DisposableContract.readiness_failures(
      hypothetical_contract,
      manifest_path: manifest_path,
      evidence_root: @evidence_directory
    )

    assert_empty evidence_failures
    assert_includes readiness_failures,
                    'trusted signed, scope-bound live attestation is unavailable; offline evidence cannot certify deployment readiness'
    refute_empty readiness_failures
  end
end
