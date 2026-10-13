"""Reproducible synthetic 96-page summary gate; no provider call or production claim."""
from __future__ import annotations
import json
import textwrap
from pathlib import Path
from unittest.mock import patch
from knowledge_extensions.pdf_parser import parse_pdf
from knowledge_extensions.document_summary import summarize_document
from knowledge_extensions.summary_evaluation import evaluate_summary,require_summary_quality
import sys
sys.path.insert(0,str(Path(__file__).parent/'tests'))
from pdf_fixture import make_text_pdf
from test_document_summary import Connection,Generator,TENANT,USER,DOCUMENT

TITLES=['Receiving inspection','Lot identification','Moisture sampling','Dryer preparation','Dryer operation',
        'Cooling procedure','Conveyor checks','Bin inspection','Aeration records','Temperature review',
        'Inspection scheduling','Maintenance isolation','Incident reporting','Document control','Operator handover','Final audit']


def run(output):
    sections=[];pages=[]
    for section,title in enumerate(TITLES,1):
        fact=f'Record synthetic checkpoint {section:02d} before closing this procedure'
        sections.append(dict(heading=title,facts=[fact]))
        for leaf in range(1,7):
            pages.append([title,*textwrap.wrap(fact+'.',54),f'Appendix record {section:02d}-{leaf} belongs to this section.',
                          'Synthetic fixture only. Not agricultural guidance.'])
    pdf=make_text_pdf(pages)
    parsed=parse_pdf(pdf,tenant_id=TENANT,document_id=DOCUMENT,document_version=1)
    sources=[dict(chunk_id=c.chunk_id,document_id=DOCUMENT,document_version=1,text=c.content,
                  page_start=c.page_start,page_end=c.page_end,heading_path=list(c.heading_path),trust='tenant_uploaded',min_role='viewer') for c in parsed.chunks]
    connection=Connection(sources)
    class Model:
        def answer(self,question,context,**kwargs):
            return dict(answer='\n\n'.join('### '+s['text'].splitlines()[0]+'\n'+s['text'] for s in context),
                        cited_chunk_ids=[s['chunk_id'] for s in context])
    with patch('knowledge_extensions.document_summary._hydrate',side_effect=lambda c,t,u,r,ids,**kw:[s for s in sources if s['chunk_id'] in ids]):
        result=summarize_document(connection,tenant_id=TENANT,principal_id=USER,principal_role='viewer',
            question='Summarize every section in original order.',document_id=DOCUMENT,document_version=1,
            answer_generator=Model(),answer_model='deterministic-fixture-double',background=True)
    answer=dict(answer=result.answer,citations=list(result.citations))
    metrics=evaluate_summary(answer,sections=sections,sources=sources)
    negative={**answer,'answer':'Receiving inspection: '+sections[0]['facts'][0],'citations':answer['citations'][:1]}
    negative_metrics=evaluate_summary(negative,sections=sections,sources=sources)
    report=dict(corpus='clearly marked synthetic storage procedure fixture',pages=96,sections=16,
        chunks=len(sources),batches=result.retrieval['summary_batches'],model='deterministic-fixture-double',
        metrics=metrics,negative_case=negative_metrics,passed=require_summary_quality(metrics) and not require_summary_quality(negative_metrics),
        production_baseline=False,semantic_faithfulness='pending independent calibrated human/model review')
    output=Path(output);output.mkdir(parents=True,exist_ok=True)
    (output/'synthetic-procedure-manual.pdf').write_bytes(pdf)
    (output/'golden-sections.json').write_text(json.dumps(sections,indent=2)+'\n')
    (output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))
    if not report['passed']:raise SystemExit(1)


if __name__=='__main__':run(sys.argv[1] if len(sys.argv)>1 else 'evidence/intelligence/summary-quality-local')
