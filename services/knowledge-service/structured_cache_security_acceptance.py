"""Provider-free real Postgres/Redis security checks on a random synthetic PDF."""
import argparse,json,os,sys
from pathlib import Path
from uuid import uuid4
import psycopg
from knowledge_extensions.pdf_parser import parse_pdf
from knowledge_extensions.source_store import save_parsed_pdf
from knowledge_extensions.graph import make_entity,make_candidate_fact
from knowledge_extensions.graph_store import persist_candidate_fact
from knowledge_extensions.retrieval import _set_tenant,_hydrate,_search_outline,_search_graph,tenant_namespace,_authorize_document_scope
from knowledge_extensions.retrieval_cache import corpus_revision,RedisJsonCache,CachedModelPorts
sys.path.insert(0,str(Path(__file__).parent/'tests'))
from pdf_fixture import make_text_pdf


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',required=True);args=p.parse_args()
    tokens=json.loads(Path(os.environ['KNOWLEDGE_MODEL_GATEWAY_TOKENS_FILE']).read_text());tenant=next(t for t in tokens if t.startswith('0a0a'))
    dsn=os.environ['KNOWLEDGE_DATABASE_URL'];admin=os.environ['KNOWLEDGE_MIGRATION_DATABASE_URL'];doc=str(uuid4())
    with psycopg.connect(dsn) as db:
        with db.transaction():
            _set_tenant(db,tenant)
            principal,roles=db.execute('SELECT principal_id::text,roles FROM knowledge_auth_memberships WHERE tenant_id=%s AND active ORDER BY principal_id LIMIT 1',(tenant,)).fetchone()
    role='admin' if 'admin' in roles else 'operator' if 'operator' in roles else 'viewer'
    pdf=make_text_pdf([['Synthetic Security Wheat','Synthetic acceptance fixture. Keep stored wheat dry and ventilated to reduce mold risk.']]);parsed=parse_pdf(pdf,tenant_id=tenant,document_id=doc,document_version=1)
    src=make_entity(tenant,'grain','Synthetic Security Wheat '+doc);dst=make_entity(tenant,'hazard','Synthetic Security Mold '+doc)
    fact=make_candidate_fact(tenant_id=tenant,source=src,target=dst,predicate='has_hazard',document_id=doc,document_version=1,chunk_id=parsed.chunks[0].chunk_id,span_start=0,span_end=40,trust='tenant_uploaded')
    report={'fixture_document':doc,'provider_calls':0,'checks':{}}
    try:
        with psycopg.connect(dsn) as db:
            save_parsed_pdf(db,parsed=parsed,acl_principals={principal});persist_candidate_fact(db,tenant_id=tenant,source=src,fact=fact,target=dst)
        with psycopg.connect(admin) as db:
            with db.transaction():
                _set_tenant(db,tenant)
                db.execute("UPDATE knowledge_document_versions SET processing_status='ready' WHERE tenant_id=%s AND document_id=%s",(tenant,doc))
                db.execute("UPDATE knowledge_graph_facts SET status='reviewed' WHERE tenant_id=%s AND fact_id=%s",(tenant,fact.edge_id))
        with psycopg.connect(dsn) as db:
            with db.transaction():
                _set_tenant(db,tenant);ids=[c.chunk_id for c in parsed.chunks]
                assert _hydrate(db,tenant,principal,role,ids,require_membership=True)
                assert _search_outline(db,tenant,principal,role,'Synthetic Security Wheat',5,(doc,1))
                assert _search_graph(db,tenant,principal,role,'Synthetic Security Wheat',5,(doc,1))
                before=corpus_revision(db,tenant,(doc,1))
                db.execute('UPDATE knowledge_document_versions SET acl_principals=%s WHERE tenant_id=%s AND document_id=%s',([str(uuid4())],tenant,doc))
                assert not _hydrate(db,tenant,principal,role,ids,require_membership=True)
                from knowledge_extensions.document_summary import DocumentSummaryError
                try:
                    _authorize_document_scope(db,tenant,principal,role,(doc,1),True)
                except DocumentSummaryError:
                    pass
                else:
                    raise AssertionError('version ACL scope admitted')
                assert before!=corpus_revision(db,tenant,(doc,1))
                report['checks']['version_acl_revocation_and_cache_revision']=True
                db.execute('UPDATE knowledge_document_versions SET acl_principals=%s WHERE tenant_id=%s AND document_id=%s',([principal],tenant,doc))
                db.execute("UPDATE knowledge_document_versions SET processing_status='failed' WHERE tenant_id=%s AND document_id=%s",(tenant,doc))
                assert not _hydrate(db,tenant,principal,role,ids,require_membership=True)
                report['checks']['nonready_version_hydration_denied']=True
                db.execute("UPDATE knowledge_document_versions SET processing_status='ready' WHERE tenant_id=%s AND document_id=%s",(tenant,doc))
                assert not _hydrate(db,tenant,str(uuid4()),role,ids,require_membership=True)
                assert not _hydrate(db,str(uuid4()),principal,role,ids,require_membership=True)
                report['checks']['foreign_tenant_and_nonmember_candidates_denied']=True
                before=corpus_revision(db,tenant,(doc,1))
                db.execute('UPDATE knowledge_documents SET current_version=2,latest_version=2 WHERE tenant_id=%s AND document_id=%s',(tenant,doc))
                assert not _hydrate(db,tenant,principal,role,ids,require_membership=True)
                assert not _search_outline(db,tenant,principal,role,'Synthetic Security Wheat',5,(doc,1))
                assert not _search_graph(db,tenant,principal,role,'Synthetic Security Wheat',5,(doc,1))
                assert before!=corpus_revision(db,tenant,(doc,1))
                report['checks']['stale_version_outline_graph_hydration_and_cache_revision']=True
        cache=RedisJsonCache(os.environ['KNOWLEDGE_REDIS_URL']);key=bytes.fromhex(os.environ['KNOWLEDGE_NAMESPACE_HMAC_KEY'])
        class NoProviders:
            def embed(self,*args,**kwargs):raise AssertionError('cache missed: provider forbidden')
        cached=CachedModelPorts(NoProviders(),cache,key)
        # These vectors were persisted by the previous real provider acceptance.
        text='Synthetic Structured Wheat Storage\nSynthetic acceptance fixture. Keep stored wheat dry and ventilated to reduce mold risk.'
        assert cached.embed([text],tenant_id=tenant,model=os.environ['KNOWLEDGE_EMBEDDING_MODEL'],input_type='passage')
        report['checks']['real_redis_real_provider_passage_vector_reused_without_call']=True
    finally:
        with psycopg.connect(admin) as db:
            with db.transaction():
                _set_tenant(db,tenant);db.execute('DELETE FROM knowledge_documents WHERE tenant_id=%s AND document_id=%s',(tenant,doc))
                for entity in (src,dst):db.execute('DELETE FROM knowledge_graph_entities WHERE tenant_id=%s AND entity_id=%s',(tenant,entity.entity_id))
        report['checks']['fixture_cleaned']=True
        Path(args.output).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report['checks']))
if __name__=='__main__':main()
