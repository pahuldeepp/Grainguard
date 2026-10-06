"""Real PDF/canonical Postgres to provider-boundary privacy acceptance."""
from uuid import uuid4
import psycopg
from guardrail_acceptance import Models, Objects
from tests.pdf_fixture import make_text_pdf
from tests.local_rag_adapters import LocalVectorStore
from knowledge_extensions.service import KnowledgeRagService
from knowledge_extensions.retrieval import retrieve_answer

TENANT='67676767-6767-4676-8676-676767676767'
USER='78787878-7878-4787-8787-787878787878'
EMAIL='operator@example.invalid'

class PrivacyModels(Models):
    def check(self, texts):
        assert all(EMAIL not in t and 'fictional-value' not in t for t in texts), 'private data reached provider'
    def embed(self, texts, **kwargs):
        self.check(texts);return super().embed(texts, **kwargs)
    def rerank(self, question, documents, **kwargs):
        self.check([question]+documents);return super().rerank(question, documents, **kwargs)
    def answer(self, question, context, **kwargs):
        self.check([question]+[c['text'] for c in context])
        return {'answer':'Keep wheat dry. Contact '+EMAIL, 'cited_chunk_ids':[context[0]['chunk_id']]}

def run(dsn):
    models=PrivacyModels();vectors=LocalVectorStore();objects=Objects();key=b'redaction-acceptance-key-32-bytes!!'
    service=KnowledgeRagService(connect=lambda:psycopg.connect(dsn), vector_store=vectors, model_gateway=models, namespace_key=key, embedding_model=models.embedding.model, reranker_model=models.reranker.model, answer_model='local-answer', object_store=objects)
    doc=str(uuid4());pdf=make_text_pdf([[EMAIL,'Keep wheat dry. Contact '+EMAIL+' password=fictional-value']])
    uploaded=service.ingest_pdf(tenant_id=TENANT,document_id=doc,document_version=1,pdf_bytes=pdf)
    service.process_document_event(tenant_id=TENANT,document_id=doc,document_version=1,event_id=uploaded.event_id)
    assert pdf in objects.data.values(), 'original PDF was altered'
    with psycopg.connect(dsn) as db:
        def ask(tenant):
            return retrieve_answer(db,tenant_id=tenant,principal_id=USER,principal_role='viewer',question='How should wheat be stored for '+EMAIL+'?',namespace_key=key,embedding_provider=models,vector_store=vectors,reranker=models,answer_generator=models,embedding_model=models.embedding.model,reranker_model=models.reranker.model,answer_model='local-answer')
        result=ask(TENANT)
        assert result.citations and EMAIL not in result.answer
        assert all(EMAIL not in str(c['heading_path']) and c['document_id']==doc and c['document_version']==1 for c in result.citations)
        assert not ask('89898989-8989-4898-8989-898989898989').citations, 'cross-tenant citation leaked'
    print('REDACTION_POSTGRES_PASS: PDF indexing, query/context egress, output, headings, original preservation, citation identity, tenant denial')
