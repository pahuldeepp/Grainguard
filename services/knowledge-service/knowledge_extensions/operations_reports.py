"""Allowlisted summaries of platform synthetic contract reports; never raw cases."""
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path


def evaluation_snapshot(path):
    unavailable = {'available': False, 'dataset': 'synthetic', 'metrics': None,
                   'note': 'No valid synthetic evaluation report is configured.'}
    if not path:
        return unavailable
    try:
        with Path(path).open('rb') as handle:
            updated = os.fstat(handle.fileno()).st_mtime
            raw = handle.read(131073)
            if len(raw) > 131072:
                return unavailable
        report = json.loads(raw)
        count = report['case_count']
        cases = report['cases']
        if (report['dataset_version'] != 'synthetic-answer-contract-v1'
                or type(count) is not int or not 1 <= count <= 1000
                or not isinstance(cases, list) or len(cases) != count
                or any(not isinstance(c, dict) or type(c.get('passed')) is not bool for c in cases)
                or type(report['passed']) is not bool
                or report['passed'] != all(c['passed'] for c in cases)):
            return unavailable
        return {'available': True, 'dataset': 'synthetic', 'production_baseline': False,
                'dataset_version': report['dataset_version'], 'case_count': count,
                'passed_count': sum(c['passed'] for c in cases), 'passed': report['passed'],
                'report_sha256': sha256(raw).hexdigest(),
                'source': 'Platform synthetic answer-contract CI report; not tenant answer quality',
                'window': datetime.fromtimestamp(updated, timezone.utc).isoformat(),
                'note': 'Synthetic contract checks only. Semantic faithfulness and a reviewed production baseline remain pending.'}
    except (OSError, ValueError, KeyError, TypeError, OverflowError):
        return unavailable
