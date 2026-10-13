"""Deterministic summary coverage/support-anchor/citation regression metrics.

Support anchors measure reviewed expected facts, not semantic faithfulness.
An optional independently calibrated human/model judge remains a release gate.
"""
from __future__ import annotations
import re


def _normal(value):
    return ' '.join(re.findall(r'\w+',value.casefold()))


def evaluate_summary(result, *, sections, sources):
    text=_normal(result['answer'])
    section_hits=sum(_normal(section['heading']) in text for section in sections)
    facts=[fact for section in sections for fact in section['facts']]
    fact_hits=sum(_normal(fact) in text for fact in facts)
    by_id={source['chunk_id']:source for source in sources}
    citations=result.get('citations',[])
    valid=[]
    for cited in citations:
        expected=by_id.get(cited.get('chunk_id'))
        valid.append(expected is not None and all(cited.get(key)==expected.get(key) for key in
            ('document_id','document_version','page_start','page_end')))
    cited_ids={c['chunk_id'] for c,okay in zip(citations,valid) if okay}
    return dict(section_coverage=section_hits/len(sections) if sections else 0,
                expected_fact_coverage=fact_hits/len(facts) if facts else 0,
                citation_accuracy=sum(valid)/len(valid) if valid else 0,
                citation_completeness=len(cited_ids)/len(by_id) if by_id else 0,
                semantic_faithfulness='requires_independent_review')


def require_summary_quality(metrics):
    return all(metrics[key]>=1.0 for key in ('section_coverage','expected_fact_coverage','citation_accuracy','citation_completeness'))
