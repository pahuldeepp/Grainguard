"""Offline calibration of independent judge labels against human-reviewed labels.

Accepts one binary supported/unsupported label per claim. Scores are not inferred
from string overlap. This module never supplies invented human annotations.
"""

def calibrate(records, *, minimum_claims=30):
    if type(minimum_claims) is not int or minimum_claims < 1:
        raise ValueError('minimum_claims must be a positive integer')
    seen = set()
    pairs = []
    for record in records:
        if not isinstance(record, dict):
            raise ValueError('each reviewed claim must be an object')
        key = (record.get('case_id'), record.get('claim_id'))
        if any(not isinstance(value, str) or not value for value in key) or key in seen:
            raise ValueError('claim IDs must be unique and nonempty')
        seen.add(key)
        if record.get('human_label') not in ('supported','unsupported') or record.get('judge_label') not in ('supported','unsupported'):
            raise ValueError('both independent labels are required')
        pairs.append((record['human_label'],record['judge_label']))
    if len(pairs) < minimum_claims:
        return {'status':'insufficient_reviewed_sample','claim_count':len(pairs),'blocking':False}
    if {human for human, _ in pairs} != {'supported','unsupported'}:
        return {'status':'missing_label_class','claim_count':len(pairs),'blocking':False}
    agreement = sum(human == judge for human, judge in pairs)/len(pairs)
    false_support = sum(human == 'unsupported' and judge == 'supported' for human, judge in pairs)
    unsupported_count = sum(human == 'unsupported' for human, _ in pairs)
    return {'status':'measured','claim_count':len(pairs),'agreement':agreement,
            'false_support_rate':false_support/unsupported_count,'blocking':False}


def main():
    import argparse
    import json
    from pathlib import Path
    parser = argparse.ArgumentParser(description='Measure independent judge/human claim-label agreement; warn-only.')
    parser.add_argument('--input', required=True, help='JSON array of reviewed claim labels')
    parser.add_argument('--output', required=True)
    parser.add_argument('--minimum-claims', type=int, default=30)
    args = parser.parse_args()
    records = json.loads(Path(args.input).read_text())
    if not isinstance(records, list):
        raise ValueError('calibration input must be a JSON array')
    result = calibrate(records, minimum_claims=args.minimum_claims)
    Path(args.output).write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
