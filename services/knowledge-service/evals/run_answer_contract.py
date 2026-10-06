"""Credential-free authored controls for the existing answer evaluator."""
import hashlib
import json
from pathlib import Path
import sys
from evals.answer_checks import check_answer


def evaluate(corpus):
    cases = corpus['cases']
    if not cases or any(not isinstance(c['id'], str) or not c['id'] for c in cases) or len({c['id'] for c in cases}) != len(cases):
        raise ValueError('answer contract case IDs must be unique and nonempty')
    results = []
    for case in cases:
        actual = set(check_answer(case['case'], case['answer'], case['citations'], corpus['context']))
        expected = set(case['expected_errors'])
        results.append({'id': case['id'], 'expected_errors': sorted(expected),
                        'actual_errors': sorted(actual), 'passed': actual == expected})
    return {'dataset_version': corpus['version'], 'case_count': len(results),
            'failure_ids': [c['id'] for c in results if not c['passed']],
            'passed': all(c['passed'] for c in results), 'cases': results,
            'semantic_faithfulness': 'not_run', 'model_attack_resistance': 'not_run',
            'production_baseline': False}


def run(output=None):
    raw = Path(__file__).with_name('answer_contract.v1.json').read_bytes()
    report = evaluate(json.loads(raw))
    report['dataset_sha256'] = hashlib.sha256(raw).hexdigest()
    destination = Path(output or Path(__file__).resolve().parents[3] / '.local/rag-evals')
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'answer-contract.json').write_text(json.dumps(report, indent=2) + '\n')
    print('ANSWER_CONTRACT_' + ('PASS' if report['passed'] else 'FAIL') + ': ' +
          json.dumps({k: report[k] for k in ('case_count', 'failure_ids')}))
    if not report['passed']:
        raise AssertionError('answer contract regression: ' + ','.join(report['failure_ids']))
    return report


if __name__ == '__main__':
    run(sys.argv[1] if len(sys.argv) == 2 else None)
