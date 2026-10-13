"""Marked synthetic PDF + real Postgres/Redis/Voyage/Pinecone acceptance.

Explicit --execute is required. This process reads protected runtime environment;
never writes user documents and deletes only its random fixture and vector IDs.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import sys
import time
from uuid import uuid4
import psycopg
from knowledge_extensions.pdf_parser import parse_pdf
from knowledge_extensions.source_store import save_parsed_pdf
from knowledge_extensions.graph import make_entity, make_candidate_fact
from knowledge_extensions.graph_store import persist_candidate_fact
from knowledge_extensions.model_gateway import ModelGatewayClient, verified_gateway_user
from knowledge_extensions.vector_store import PineconeVectorStore
from knowledge_extensions.retrieval import process_index_event, retrieve_answer, tenant_namespace, _hydrate, _search_outline, _search_graph, _set_tenant
from knowledge_extensions.retrieval_cache import RedisJsonCache, corpus_revision, CachedModelPorts
sys.path.insert(0,str(Path(__file__).parent/'tests'))
from pdf_fixture import make_text_pdf


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--execute',action='store_true');parser.add_argument('--output',required=True)
    args=parser.parse_args()
    if not args.execute:parser.error('--execute required')
    tokens=json.loads(Path(os.environ['KNOWLEDGE_MODEL_GATEWAY_TOKENS_FILE']).read_text())
    tenant=os.environ.get('STRUCTURED_FIXTURE_TENANT') or next(t for t in tokens if t.startswith('0a0a'))
    app_dsn=os.environ['KNOWLEDGE_DATABASE_URL'];admin_dsn=os.environ['KNOWLEDGE_MIGRATION_DATABASE_URL']
    with psycopg.connect(app_dsn) as connection:
        with connection.transaction():
            _set_tenant(connection,tenant)
            membership=connection.execute("SELECT principal_id::text,roles FROM knowledge_auth_memberships WHERE tenant_id=%s AND active ORDER BY principal_id LIMIT 1",(tenant,)).fetchone()
    assert membership,'synthetic tenant lacks membership'
    principal=membership[0];role='admin' if 'admin' in membership[1] else 'operator' if 'operator' in membership[1] else 'viewer'
    document=str(uuid4());key=bytes.fromhex(os.environ['KNOWLEDGE_NAMESPACE_HMAC_KEY']);namespace=tenant_namespace(tenant,key)
    raw_pdf=make_text_pdf([['Synthetic Structured Wheat Storage','Synthetic acceptance fixture. Keep stored wheat dry and ventilated to reduce mold risk.']])
    parsed=parse_pdf(raw_pdf,tenant_id=tenant,document_id=document,document_version=1)
    secret_file=os.environ.get('PINECONE_API_KEY_FILE');secret=Path(secret_file).read_text().strip() if secret_file else os.environ['PINECONE_API_KEY']
    vectors=PineconeVectorStore(index_host=os.environ['PINECONE_INDEX_HOST'],api_key=secret)
    models=ModelGatewayClient(base_url=os.environ['KNOWLEDGE_MODEL_GATEWAY_URL'],task_token=lambda t:tokens[t],timeout_seconds=90)
    redis_url=os.environ.get('KNOWLEDGE_REDIS_URL')
    if not redis_url and os.environ.get('KNOWLEDGE_REDIS_URL_FILE'):redis_url=Path(os.environ['KNOWLEDGE_REDIS_URL_FILE']).read_text().strip()
    assert redis_url,'KNOWLEDGE_REDIS_URL required'
    cache=RedisJsonCache(redis_url)
    probe=cache.key('probe',[document]);cache.put(probe,['synthetic']);assert cache.get(probe)==['synthetic'],'real Redis not ready'
    models=CachedModelPorts(models,cache,key)
    source=make_entity(tenant,'grain','Synthetic Wheat '+document);target=make_entity(tenant,'hazard','Synthetic Mold '+document)
    fact=make_candidate_fact(tenant_id=tenant,source=source,target=target,predicate='has_hazard',document_id=document,document_version=1,chunk_id=parsed.chunks[0].chunk_id,span_start=0,span_end=40,trust='tenant_uploaded')
    output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True)
    report={'fixture_document':document,'real':['PDFium PDF parser','Postgres canonical chunks/outlines/reviewed graph','Redis','Voyage embeddings/rerank via gateway','Pinecone','gateway answer provider'],'checks':{}}
    print('Waiting 65 seconds before provider traffic',flush=True)
    time.sleep(55)
    time.sleep(10)
    try:
        with psycopg.connect(app_dsn) as connection:
            save_parsed_pdf(connection,parsed=parsed,acl_principals={principal})
            persist_candidate_fact(connection,tenant_id=tenant,source=source,fact=fact,target=target)
            with connection.transaction():
                _set_tenant(connection,tenant)
                event=connection.execute('SELECT event_id::text FROM knowledge_index_outbox WHERE tenant_id=%s AND document_id=%s',(tenant,document)).fetchone()[0]
            with verified_gateway_user(principal,deadline_seconds=110,call_timeout_seconds=90):
                count=process_index_event(connection,tenant_id=tenant,event_id=event,namespace_key=key,embedding_provider=models,vector_store=vectors,embedding_model=os.environ['KNOWLEDGE_EMBEDDING_MODEL'])
            assert count==len(parsed.chunks)
            from knowledge_extensions.redaction import redact_passages
            passage_keys=[cache.key('embedding',[namespace,os.environ['KNOWLEDGE_EMBEDDING_MODEL'],'passage',text]) for text in redact_passages([c.content for c in parsed.chunks])]
            assert all(cache.get(k) for k in passage_keys)
            cached_passages=models.embed([c.content for c in parsed.chunks],tenant_id=tenant,model=os.environ['KNOWLEDGE_EMBEDDING_MODEL'],input_type='passage')
            assert len(cached_passages)==len(parsed.chunks)
            report['checks']['real_redis_passage_embedding_repeat']=True
        with psycopg.connect(admin_dsn) as reviewer:
            with reviewer.transaction():
                _set_tenant(reviewer,tenant)
                reviewer.execute("UPDATE knowledge_graph_facts SET status='reviewed' WHERE tenant_id=%s AND fact_id=%s",(tenant,fact.edge_id))
        with psycopg.connect(app_dsn) as connection:
            kwargs=dict(tenant_id=tenant,principal_id=principal,principal_role=role,question='How does Synthetic Wheat storage reduce mold risk?',namespace_key=key,embedding_provider=models,vector_store=vectors,reranker=models,answer_generator=models,embedding_model=os.environ['KNOWLEDGE_EMBEDDING_MODEL'],reranker_model=os.environ['KNOWLEDGE_RERANKER_MODEL'],answer_model=os.environ['KNOWLEDGE_ANSWER_MODEL'],context_k=1,require_membership=True,document_id=document,document_version=1,cache=cache)
            trace={}
            with verified_gateway_user(principal,deadline_seconds=150,call_timeout_seconds=90):
                answer=retrieve_answer(connection,evaluation_trace=trace,**kwargs)
            canonical={c.chunk_id for c in parsed.chunks}
            assert answer.citations and {c['chunk_id'] for c in answer.citations}<=canonical
            for leg in ('pageindex','knowledge_graph'):
                ids=set(trace['rankings'][leg]);assert ids and ids<=canonical
                assert ids & set(trace['fused_candidate_ids']) & set(trace['candidate_ids']) & {c['chunk_id'] for c in trace['context']}
            report['checks']['structured_ids_ranked_hydrated_and_cited']=True
            report['retrieval']=answer.retrieval;report['trace']=trace
            output.write_text(json.dumps(report,indent=2)+'\n')
            print('First real structured retrieval passed; pacing cached repeat 65 seconds',flush=True)
            time.sleep(55)
            time.sleep(10)
            repeated={}
            with verified_gateway_user(principal,deadline_seconds=150,call_timeout_seconds=90):
                repeat=retrieve_answer(connection,evaluation_trace=repeated,**kwargs)
            assert repeated['candidate_cache_hit'] and repeat.citations
            report['repeat_trace']=repeated
            report['checks']['real_redis_repeat_hit']=True
            with connection.transaction():
                _set_tenant(connection,tenant)
                before=corpus_revision(connection,tenant,(document,1))
                assert not _hydrate(connection,tenant,str(uuid4()),role,list(canonical),require_membership=True)
                assert not _hydrate(connection,str(uuid4()),principal,role,list(canonical),require_membership=True)
                connection.execute('UPDATE knowledge_documents SET acl_principals=%s WHERE tenant_id=%s AND document_id=%s',([str(uuid4())],tenant,document))
                after=corpus_revision(connection,tenant,(document,1));assert before!=after
                assert not _hydrate(connection,tenant,principal,role,list(canonical),require_membership=True)
                assert not _search_outline(connection,tenant,principal,role,'Synthetic Wheat',5,(document,1))
                assert not _search_graph(connection,tenant,principal,role,'Synthetic Wheat',5,(document,1))
                report['checks']['foreign_tenant_membership_acl_revocation_and_revision']=True
                connection.execute('UPDATE knowledge_documents SET acl_principals=%s,current_version=2,latest_version=2 WHERE tenant_id=%s AND document_id=%s',([principal],tenant,document))
                assert not _hydrate(connection,tenant,principal,role,list(canonical),require_membership=True)
                assert not _search_outline(connection,tenant,principal,role,'Synthetic Wheat',5,(document,1))
                assert not _search_graph(connection,tenant,principal,role,'Synthetic Wheat',5,(document,1))
                report['checks']['stale_version_candidates_denied']=True
    except Exception as exc:
        report['failure']={'type':type(exc).__name__,'status':getattr(exc,'status',None),'code':getattr(exc,'code',None),'retry_after':getattr(exc,'retry_after',None)}
        print(json.dumps(report['failure']),flush=True)
        raise
    finally:
        vectors.delete(namespace=namespace,chunk_ids=[c.chunk_id for c in parsed.chunks])
        with psycopg.connect(admin_dsn) as connection:
            with connection.transaction():
                _set_tenant(connection,tenant)
                connection.execute('DELETE FROM knowledge_documents WHERE tenant_id=%s AND document_id=%s',(tenant,document))
                for entity in (source,target):
                    connection.execute('DELETE FROM knowledge_graph_entities e WHERE tenant_id=%s AND entity_id=%s AND NOT EXISTS (SELECT 1 FROM knowledge_graph_facts f WHERE f.tenant_id=e.tenant_id AND (f.source_entity_id=e.entity_id OR f.target_entity_id=e.entity_id))',(tenant,entity.entity_id))
        report['checks']['fixture_and_vectors_cleaned']=True
        output.write_text(json.dumps(report,indent=2)+'\n')
    Path(args.output).parent.mkdir(parents=True,exist_ok=True);Path(args.output).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'checks':report['checks'],'retrieval':report['retrieval']}))

if __name__=='__main__':main()
