"""Golden retrieval eval executed inside disposable Postgres acceptance."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sys
from uuid import NAMESPACE_URL, uuid5

import psycopg
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'tests'))
from pdf_fixture import make_text_pdf
from local_rag_adapters import LocalEmbedding, LocalReranker, LocalVectorStore
from knowledge_extensions.pdf_parser import parse_pdf
from knowledge_extensions.retrieval import retrieve_answer, process_index_event, RetrievalError, tenant_namespace
from knowledge_extensions.source_store import save_parsed_pdf
from knowledge_extensions.vector_store import VectorHit
from evals.answer_checks import check_answer, is_abstention
from knowledge_extensions.model_gateway import ModelGatewayError
from knowledge_extensions.prompt_guardrails import inspect_text, PromptInjectionError
from knowledge_extensions.evaluation import recall_at_k, ndcg_at_k, unsupported_numbers, gate

A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
USER='cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
KEY=b'golden-eval-synthetic-namespace-key-32-bytes'

class ExtractiveAnswer:
    def answer(self, question, context, **kwargs):
        return {'answer':'\n'.join(item['text'] for item in context),'cited_chunk_ids':[item['chunk_id'] for item in context]}


def run(app_dsn: str):
    live = os.environ.get('RAG_EVAL_LIVE') == '1'
    if not live:
        return _run(app_dsn)
    from evals.live_adapters import LivePorts
    ports = LivePorts()
    try:
        return _run(app_dsn, ports)
    finally:
        ports.close()


def _run(app_dsn: str, ports=None):
    path=Path(__file__).with_name('golden.v3.json')
    raw=path.read_bytes();gold=json.loads(raw)
    if len({case['id'] for case in gold['cases']})!=len(gold['cases']) or not gold['cases']:
        raise ValueError('golden case IDs must be unique and nonempty')
    doc_ids={doc['id'] for doc in gold['documents']}
    if len(doc_ids)!=len(gold['documents']):raise ValueError('duplicate golden document IDs')
    for case in gold['cases']:
        if not case['relevance'] or set(case['relevance'])-doc_ids or not case['must_contain']:
            raise ValueError('golden labels must reference documents and required facts')
    combined_cases = gold['cases'] + gold['behavior_cases']
    if len({case['id'] for case in combined_cases}) != len(combined_cases):
        raise ValueError('all evaluation case IDs must be unique')
    for case in gold['behavior_cases']:
        if case['kind'] not in ('ambiguous','conflicting','unanswerable','injection') or set(case['relevance']) - doc_ids:
            raise ValueError('invalid behavior case')
        if (case['kind'] == 'unanswerable') != (not case['relevance']):
            raise ValueError('only unanswerable cases may omit relevance labels')
    embedding=LocalEmbedding();reranker=LocalReranker();vectors=LocalVectorStore();chunk_docs={};truth={};forbidden=[]
    embedding_model = embedding.model
    reranker_model = reranker.model
    namespace_key = KEY
    if ports is not None:
        embedding = reranker = vectors = ports
        embedding_model, reranker_model = 'embed-v1', 'rerank-v1'
        namespace_key = os.urandom(32)
    if ports is not None:
        passages = []
        for doc in gold['documents']:
            parsed = parse_pdf(make_text_pdf([[doc['title'],doc['text']]]), tenant_id=A, document_id=str(uuid5(NAMESPACE_URL,gold['version']+':'+doc['id'])), document_version=1)
            passages.extend(c.content for c in parsed.chunks if not inspect_text(c.content))
        passages.extend(c.content for c in parse_pdf(make_text_pdf([['Wheat Moisture','Superseding synthetic wheat target: 12 percent.']]),tenant_id=A,document_id=str(uuid5(NAMESPACE_URL,gold['version']+':drying')),document_version=2).chunks)
        ports.embed(passages,model=embedding_model,input_type='passage')
        questions = [case['question'] for case in gold['cases'] + gold['behavior_cases']] + ['What is the private maintenance access code?', 'What moisture target applies to wheat?', 'How should wheat be stored?']
        ports.embed([q for q in questions if not inspect_text(q)],model=embedding_model,input_type='query')
    document_ids = {}
    rejected_documents = []
    pdf_output = Path(os.environ.get('RAG_EVAL_OUTPUT_DIR', str(Path(__file__).resolve().parents[3]/'.local/rag-evals')))/'fixtures'
    pdf_output.mkdir(parents=True, exist_ok=True)
    with psycopg.connect(app_dsn) as db:
        for doc in gold['documents']:
            if ports is not None:
                print('LIVE_EVAL_INDEX: '+doc['id'], flush=True)
            tenant=B if doc.get('tenant')=='b' else A
            doc_id=str(uuid5(NAMESPACE_URL,gold['version']+':'+doc['id']))
            document_ids[doc['id']] = doc_id
            pdf = make_text_pdf([[doc['title'], doc['text']]])
            (pdf_output/(doc['id']+'.pdf')).write_bytes(pdf)
            parsed=parse_pdf(pdf,tenant_id=tenant,document_id=doc_id,document_version=1)
            if doc.get('expected_guardrail') == 'block':
                if not any(inspect_text(c.content) for c in parsed.chunks):
                    raise AssertionError('malicious fixture was not detected')
                rejected_documents.append(doc['id'])
                continue
            save_parsed_pdf(db,parsed=parsed,min_role=doc.get('min_role','viewer'),acl_principals=set(doc.get('acl_principals',[])))
            with db.transaction():
                db.execute("SELECT set_config('app.tenant_id',%s,true)",(tenant,))
                event=db.execute('SELECT event_id::text FROM knowledge_index_outbox WHERE tenant_id=%s AND document_id=%s',(tenant,doc_id)).fetchone()[0]
            process_index_event(db,tenant_id=tenant,event_id=event,namespace_key=namespace_key,embedding_provider=embedding,vector_store=vectors,embedding_model=embedding_model)
            for chunk in parsed.chunks:
                chunk_docs[chunk.chunk_id]=doc['id']
                truth[chunk.chunk_id]={'document_id':doc_id,'document_version':1,'page_start':chunk.page_start,'page_end':chunk.page_end,'text':chunk.content}
                if tenant==B or doc.get('min_role')=='admin' or doc.get('acl_principals'):forbidden.append(chunk.chunk_id)
        (pdf_output/'synthetic-operations-manual.pdf').write_bytes(make_text_pdf([['Synthetic Evaluation Manual', 'Fictional test data only. Not agricultural advice. Not customer material.']] + [[doc['title'], doc['text']] for doc in gold['documents']]))
        if ports is not None:
            ports.await_index()
        def query(question, answerer=None, store=None, role='viewer'):
            trace={}
            result=retrieve_answer(db,tenant_id=A,principal_id=USER,principal_role=role,question=question,namespace_key=namespace_key,embedding_provider=embedding,vector_store=store or vectors,reranker=reranker,answer_generator=answerer or ExtractiveAnswer(),embedding_model=embedding_model,reranker_model=reranker_model,answer_model='answer-v1' if answerer is ports and ports is not None else 'synthetic-extractive-v1',candidate_k=20,context_k=5,evaluation_trace=trace)
            return result,trace
        results=[];citation_correct=0;citation_count=0;numeric_errors=0;facts_hit=0;facts_total=0
        for case in gold['cases']:
            if ports is not None:
                print('LIVE_EVAL_QUERY: '+case['id'], flush=True)
            result,trace=query(case['question'])
            ranked=list(dict.fromkeys(chunk_docs[c] for c in trace['candidate_ids']))
            reranked=list(dict.fromkeys(chunk_docs[c['chunk_id']] for c in trace['context']))
            context={c['chunk_id']:c['text'] for c in trace['context']}
            for citation in result.citations:
                citation_count+=1;expected=truth.get(citation['chunk_id'])
                citation_correct+=int(expected is not None and citation['chunk_id'] in context and citation['chunk_id'] not in forbidden and all(citation[k]==expected[k] for k in ['document_id','document_version','page_start','page_end']))
            numeric_errors+=len(unsupported_numbers(result.answer,[context[c['chunk_id']] for c in result.citations if c['chunk_id'] in context]))
            hits=sum(f.casefold() in result.answer.casefold() for f in case['must_contain']);facts_hit+=hits;facts_total+=len(case['must_contain'])
            results.append({'id':case['id'],'recall_at_10':recall_at_k(ranked,case['relevance'],10),'ndcg_at_5':ndcg_at_k(reranked,case['relevance'],5),'reference_facts_hit':hits,'retrieved_documents':reranked})
        generated_results = []
        generated_status = 'not_run'
        if ports is not None and os.environ.get('RAG_EVAL_CLAUDE') == '1':
            generated_status = 'completed'
            for case in gold['cases'] + gold['behavior_cases']:
                try:
                    generated, trace = query(case['question'], answerer=ports)
                except PromptInjectionError:
                    generated_results.append({'id':case['id'], 'status':'guardrail_blocked'})
                    continue
                except ModelGatewayError as error:
                    generated_status = 'incomplete_provider_unavailable'
                    generated_results.append({'id':case['id'], 'status':'not_run', 'gateway_status':error.status})
                    break
                checked_case = dict(case)
                checked_case['supported_claims'] = [
                    {'anchor': fact, 'source_chunk_ids': [
                        item['chunk_id'] for item in trace['context']
                        if fact.casefold() in item['text'].casefold()]}
                    for fact in case.get('must_contain', [])
                ]
                if case.get('kind') in ('conflicting', 'ambiguous'):
                    checked_case['expected_document_ids'] = [document_ids[doc] for doc in case['relevance']]
                errors = check_answer(checked_case, generated.answer, generated.citations, trace['context'])
                generated_results.append({'id':case['id'], 'status':'completed', 'cited_chunk_ids':[c['chunk_id'] for c in generated.citations], 'context_chunk_ids':[c['chunk_id'] for c in trace['context']], 'deterministic_failures':errors, 'faithfulness':'pending_independent_human_calibration', 'human_review':None, 'judge_review':None})
        failures=[]
        class PoisonedVector:
            def search(self, **kwargs):
                meta={'tenant_ref':tenant_namespace(A,namespace_key),'embedding_version':embedding_model,'tombstone':False}
                return [VectorHit(c,1.0,meta) for c in forbidden]+vectors.search(**kwargs)
        result,trace=query('What is the private maintenance access code?',store=PoisonedVector())
        if any(c['chunk_id'] in forbidden for c in trace['context']) or any(c['chunk_id'] in forbidden for c in result.citations):failures.append('unauthorized_hydration')
        class ForgedCitations:
            def __init__(self, mode):self.mode=mode
            def answer(self,question,context,**kwargs):
                ids=[next(c for c, doc in chunk_docs.items() if doc == 'foreign')] if self.mode=='foreign' else [context[0]['chunk_id']]*2 if self.mode=='duplicate' else []
                return {'answer':'Synthetic unsafe response','cited_chunk_ids':ids}
        for mode in ['foreign','duplicate']:
            try:query('What moisture target applies to wheat?',answerer=ForgedCitations(mode))
            except RetrievalError:pass
            else:failures.append('citation_'+mode)
        # Empty citations are normalized to a fixed abstention, discarding prose.
        missing, _ = query('What moisture target applies to wheat?', answerer=ForgedCitations('missing'))
        if missing.citations or not is_abstention(missing.answer):
            failures.append('citation_missing_abstention')

        # Exercise revocation and stale vector results against canonical hydration.
        drying_chunks = [c for c, doc in chunk_docs.items() if doc == 'drying']
        with db.transaction():
            db.execute("SELECT set_config('app.tenant_id',%s,true)",(A,))
            db.execute("UPDATE knowledge_documents SET min_role='admin' WHERE tenant_id=%s AND document_id=%s", (A, document_ids['drying']))
        _, revoked = query('What moisture target applies to wheat?')
        if any(c['chunk_id'] in drying_chunks for c in revoked['context']):
            failures.append('revoked_access')
        with db.transaction():
            db.execute("SELECT set_config('app.tenant_id',%s,true)",(A,))
            db.execute("UPDATE knowledge_documents SET min_role='viewer' WHERE tenant_id=%s AND document_id=%s", (A, document_ids['drying']))
        updated = parse_pdf(make_text_pdf([['Wheat Moisture', 'Superseding synthetic wheat target: 12 percent.']]), tenant_id=A, document_id=document_ids['drying'], document_version=2)
        save_parsed_pdf(db, parsed=updated)
        with db.transaction():
            db.execute("SELECT set_config('app.tenant_id',%s,true)",(A,))
            event = db.execute('SELECT event_id::text FROM knowledge_index_outbox WHERE tenant_id=%s AND document_id=%s AND document_version=2', (A,document_ids['drying'])).fetchone()[0]
        process_index_event(db, tenant_id=A, event_id=event, namespace_key=namespace_key, embedding_provider=embedding, vector_store=vectors, embedding_model=embedding_model)
        class StaleVector:
            def search(self, **kwargs):
                meta={'tenant_ref':tenant_namespace(A,namespace_key),'embedding_version':embedding_model,'tombstone':False}
                return [VectorHit(c, 1.0, meta) for c in drying_chunks] + vectors.search(**kwargs)
        _, stale = query('What moisture target applies to wheat?', store=StaleVector())
        if any(c['chunk_id'] in drying_chunks for c in stale['context']):
            failures.append('stale_version')

        behavior_results = []
        behavior_failures = []
        for case in gold['behavior_cases']:
            class ContractAnswer:
                def answer(self, question, context, **kwargs):
                    if case['kind'] in ('unanswerable', 'injection'):
                        return {'answer':'Discard this uncited model prose.', 'cited_chunk_ids':[]}
                    return ExtractiveAnswer().answer(question, context, **kwargs)
            if case.get('expected_guardrail') == 'block':
                if set(case['relevance']) - set(rejected_documents):
                    behavior_failures.append(case['id']+':source_not_rejected')
                try:
                    query(case['question'], answerer=ContractAnswer())
                except PromptInjectionError:
                    behavior_results.append({'id':case['id'],'kind':case['kind'],'status':'guardrail_blocked','answer_quality_status':'not_run'})
                else:
                    behavior_failures.append(case['id']+':guardrail_miss')
                continue
            result, trace = query(case['question'], answerer=ContractAnswer())
            documents = list(dict.fromkeys(chunk_docs.get(c['chunk_id'], 'updated') for c in trace['context']))
            missing_docs = sorted(set(case['relevance']) - set(documents))
            if missing_docs:
                behavior_failures.append(case['id']+':required_context')
            if case['kind'] in ('unanswerable', 'injection') and (result.citations or not is_abstention(result.answer)):
                behavior_failures.append(case['id']+':abstention_contract')
            behavior_results.append({'id':case['id'], 'kind':case['kind'], 'retrieved_documents':documents, 'missing_relevant_documents':missing_docs, 'contract_answer':result.answer, 'answer_quality_status':'not_run', 'reason':'Explicit case-conditioned contract stub; does not establish model reasoning or injection resistance.'})

        with db.transaction():
            db.execute("SELECT set_config('app.tenant_id',%s,true)",(B,))
            if db.execute('SELECT count(*) FROM knowledge_chunks WHERE tenant_id=%s',(A,)).fetchone()[0]!=0:failures.append('rls_cross_tenant')
        empty=retrieve_answer(db,tenant_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',principal_id=USER,principal_role='viewer',question='How should wheat be stored?',namespace_key=namespace_key,embedding_provider=embedding,vector_store=vectors,reranker=reranker,answer_generator=ExtractiveAnswer(),embedding_model=embedding_model,reranker_model=reranker_model,answer_model='synthetic-extractive-v1')
        if empty.citations or not is_abstention(empty.answer):failures.append('empty_tenant_abstention')
        # Hard rejection checks cannot be averaged away by easy quality cases.
        report={'dataset_version':gold['version'],'dataset_sha256':hashlib.sha256(raw).hexdigest(),'case_count':len(results),'recall_at_10':sum(r['recall_at_10'] for r in results)/len(results),'ndcg_at_5':sum(r['ndcg_at_5'] for r in results)/len(results),'citation_accuracy':citation_correct/citation_count if citation_count else 0,'reference_fact_coverage':facts_hit/facts_total,'unsupported_numbers':numeric_errors,'security_failures':len(failures),'security_failure_ids':failures,'security_cases':['unauthorized_hydration_foreign_role_acl','citation_foreign','citation_duplicate','citation_missing_abstention','revoked_access','stale_version','rls_cross_tenant','empty_tenant_abstention'],'cases':results,'configuration':{'embedding':embedding_model,'reranker':reranker_model,'answer':'synthetic-extractive-v1','candidate_k':20,'context_k':5,'metric_level':'document','retrieval':'production Postgres FTS/PageIndex/graph/RRF/hydration'},'semantic_faithfulness':{'status':'not_run','blocking':False,'reason':'Requires funded independent judge, calibration and sufficient sample; deterministic support is not semantic faithfulness.'},'prompt_injection_robustness':{'status':'not_run','reason':'Synthetic extractive answers do not prove model resistance to prompt injection.'}}
        report['generated_answer_checks'] = {'status':generated_status, 'model':'answer-v1' if ports is not None and os.environ.get('RAG_EVAL_CLAUDE') == '1' else None, 'blocking':False, 'cases':generated_results}
        report['configuration']['generated_answer'] = report['generated_answer_checks']['model']
        report['behavior_failures'] = len(behavior_failures)
        report['behavior_failure_ids'] = behavior_failures
        report['behavior_cases'] = behavior_results
        report['rejected_documents'] = rejected_documents
        report['configuration']['prompt_guardrail_policy'] = 'static-injection-v1'
        report['corpus_review'] = gold['review']
        report['configuration']['provider_mode'] = 'live_voyage_pinecone' if ports is not None else 'local_test_doubles'
        report['gate_failures']=gate(report,gold['thresholds']);report['passed']=not report['gate_failures']
        output=Path(os.environ.get('RAG_EVAL_OUTPUT_DIR',str(Path(__file__).resolve().parents[3]/'.local/rag-evals')))
        output.mkdir(parents=True,exist_ok=True)
        (output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
        (output/'summary.md').write_text('# Synthetic RAG eval\n\n'+ '\n'.join(f'- {k}: {report[k]}' for k in ['dataset_version','case_count','recall_at_10','ndcg_at_5','citation_accuracy','reference_fact_coverage','unsupported_numbers','security_failures','behavior_failures','passed'])+'\n\nSemantic faithfulness and model prompt-injection robustness: not run.\n')
        print('RAG_EVAL_'+('PASS' if report['passed'] else 'FAIL')+': '+json.dumps({k:report[k] for k in ['case_count','recall_at_10','ndcg_at_5','citation_accuracy','security_failures','gate_failures']}))
        if not report['passed']:raise AssertionError('RAG eval quality gate failed: '+','.join(report['gate_failures']))
        return report
