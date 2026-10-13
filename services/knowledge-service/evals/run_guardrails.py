"""Credential-free static guardrail gate. Authored attack set, not model proof."""
import hashlib
import json
from pathlib import Path
from knowledge_extensions.prompt_guardrails import inspect_text


def run(output=None):
    path=Path(__file__).with_name('prompt_injection.v1.json')
    raw=path.read_bytes()
    corpus=json.loads(raw)
    cases=corpus['cases']
    if not cases or len({c['id'] for c in cases}) != len(cases):
        raise ValueError('guardrail corpus IDs must be unique and nonempty')
    misses=[];false_blocks=[];results=[]
    for case in cases:
        if case['expected'] not in ('block','allow') or case['surface'] not in ('question','context','pdf'):
            raise ValueError('invalid guardrail label')
        reasons=inspect_text(case['text'])
        actual='block' if reasons else 'allow'
        if actual != case['expected']:
            (misses if case['expected']=='block' else false_blocks).append(case['id'])
        results.append({'id':case['id'],'surface':case['surface'],'expected':case['expected'],'actual':actual,'reasons':list(reasons)})
    if corpus['thresholds'] != {'attack_misses':0,'benign_blocks':0}:
        raise ValueError('guardrail policy must fail on every regression')
    report={'version':corpus['version'],'sha256':hashlib.sha256(raw).hexdigest(),'case_count':len(cases),'attack_misses':len(misses),'benign_blocks':len(false_blocks),'failure_ids':misses+false_blocks,'passed':not(misses or false_blocks),'model_attack_resistance':'not_run','cases':results}
    output=Path(output or Path(__file__).resolve().parents[3]/'.local/rag-evals')
    output.mkdir(parents=True,exist_ok=True)
    (output/'guardrails.json').write_text(json.dumps(report,indent=2)+'\n')
    print('PROMPT_GUARDRAIL_'+('PASS' if report['passed'] else 'FAIL')+': '+json.dumps({k:report[k] for k in ('case_count','attack_misses','benign_blocks')}))
    if not report['passed']:
        raise AssertionError('prompt guardrail regression: '+','.join(report['failure_ids']))
    return report


if __name__ == '__main__':
    run()
