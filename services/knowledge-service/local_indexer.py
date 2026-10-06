"""Explicit Docker Desktop development profile; never a gVisor security proof.

Production worker.py/ContainerPdfParser remain strict. This localhost-only,
local-synthetic profile exercises real Kafka/ClamAV/storage/models/vectors using
an immutable local image ID and a network-free non-root container.
"""
from __future__ import annotations
import json,os,re,signal,subprocess,threading
from urllib.parse import urlsplit
from uuid import uuid4
import psycopg
from confluent_kafka import Consumer,Producer
from migrate import validate_local_dsn
from serve import _required,_provider_secret,_tenant_gateway_tokens
from knowledge_extensions.file_validation import ClamAvScanner
from knowledge_extensions.kafka_runtime import TOPIC,consume_forever,publish_pending_once
from knowledge_extensions.model_gateway import ModelGatewayClient
from knowledge_extensions.object_storage import S3PdfObjectStore,S3SourceConfig
from knowledge_extensions.parser_sandbox import run_bounded,bind_passages
from knowledge_extensions.pdf_parser import MAX_PDF_BYTES,PdfParseError
from knowledge_extensions.service import KnowledgeRagService
from knowledge_extensions.vector_store import PineconeVectorStore


def validate_config(env):
    if env.get('KNOWLEDGE_ENVIRONMENT')!='local-synthetic':
        raise ValueError('local synthetic profile is required')
    validate_local_dsn(env.get('KNOWLEDGE_DATABASE_URL',''))
    for name in ('KNOWLEDGE_S3_ENDPOINT','KNOWLEDGE_MODEL_GATEWAY_URL'):
        parsed=urlsplit(env.get(name,''))
        if (parsed.scheme!='http' or parsed.hostname not in {'127.0.0.1','localhost','::1'}
                or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'','/'}):
            raise ValueError('local indexing infrastructure endpoints required')
    brokers=env.get('KNOWLEDGE_KAFKA_BOOTSTRAP_SERVERS','').split(',')
    if not brokers or any(not re.fullmatch(r'(?:127\.0\.0\.1|localhost):[0-9]{2,5}',broker) for broker in brokers):
        raise ValueError('localhost Kafka required')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}',env.get('KNOWLEDGE_LOCAL_PARSER_IMAGE_ID','')):
        raise ValueError('immutable local parser image ID required')


class LocalSyntheticParser:
    def __init__(self,image):
        if not re.fullmatch(r'sha256:[0-9a-f]{64}',image):raise ValueError('immutable local image ID required')
        self.image=image
    def parse(self,data,*,tenant_id,document_id,document_version):
        if not data.startswith(b'%PDF-') or not 8<=len(data)<=MAX_PDF_BYTES:raise PdfParseError('invalid bounded PDF')
        name='gg-local-parser-'+uuid4().hex
        command=['docker','run','--rm','-i','--name',name,'--network=none','--read-only','--cap-drop=ALL',
            '--security-opt=no-new-privileges','--memory=512m','--memory-swap=512m','--cpus=1',
            '--pids-limit=64','--user=10001:10001','--tmpfs=/tmp:rw,noexec,nosuid,size=32m',
            '--log-driver=none','--env','KNOWLEDGE_PARSER_OCR=true',self.image]
        try:payload=run_bounded(command,data,120)
        finally:
            try:subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
            except (OSError,subprocess.SubprocessError):pass
        return bind_passages(payload,data=data,tenant_id=tenant_id,document_id=document_id,document_version=document_version)


def main():
    validate_config(os.environ)
    if os.environ.get('KNOWLEDGE_WORKER_ROLE','indexer') not in {'indexer','relay'}:
        raise SystemExit('local profile role must be relay or indexer')
    with open(_required('KNOWLEDGE_RELAY_TENANTS_FILE'),encoding='utf-8') as h:tenants=json.load(h)
    from knowledge_extensions.oidc_auth import canonical_uuid
    if not isinstance(tenants,list) or not 1<=len(tenants)<=10 or not all(canonical_uuid(t) for t in tenants):
        raise SystemExit('explicit local test tenant allowlist required')
    tokens=_tenant_gateway_tokens(_required('KNOWLEDGE_MODEL_GATEWAY_TOKENS_FILE'))
    if set(tenants)-tokens.keys():raise SystemExit('local test tenant gateway tokens required')
    connect=lambda:psycopg.connect(_required('KNOWLEDGE_DATABASE_URL'),connect_timeout=5,options='-c statement_timeout=10000 -c lock_timeout=2000')
    kafka={'bootstrap.servers':_required('KNOWLEDGE_KAFKA_BOOTSTRAP_SERVERS')}
    stop=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stop.set());signal.signal(signal.SIGINT,lambda *_:stop.set())
    if os.environ.get('KNOWLEDGE_WORKER_ROLE')=='relay':
        producer=Producer(kafka)
        while not stop.is_set():
            for tenant in tenants:
                if stop.is_set():break
                try:publish_pending_once(connect,producer,tenant)
                except Exception:print('local relay dependency unavailable',flush=True)
            stop.wait(1)
        producer.flush(10);return
    class ScopedService(KnowledgeRagService):
        def process_document_event(self,**event):
            if event['tenant_id'] not in tenants:raise PdfParseError('local test tenant not enabled')
            return super().process_document_event(**event)
        def record_index_failure(self,*,event,**kwargs):
            if event['tenant_id'] not in tenants:return True
            return super().record_index_failure(event=event,**kwargs)
    service=ScopedService(connect=connect,parser=LocalSyntheticParser(_required('KNOWLEDGE_LOCAL_PARSER_IMAGE_ID')),
        scanner=ClamAvScanner(host='127.0.0.1',port=3310),
        object_store=S3PdfObjectStore(S3SourceConfig(bucket=_required('KNOWLEDGE_S3_BUCKET'),region=_required('KNOWLEDGE_S3_REGION'),
            kms_key_id=_required('KNOWLEDGE_S3_KMS_KEY_ID'),endpoint_url=_required('KNOWLEDGE_S3_ENDPOINT'))),
        vector_store=PineconeVectorStore(index_host=_required('PINECONE_INDEX_HOST'),api_key=_provider_secret('PINECONE_API_KEY')),
        model_gateway=ModelGatewayClient(base_url=_required('KNOWLEDGE_MODEL_GATEWAY_URL'),task_token=lambda tenant:tokens[tenant]),
        namespace_key=bytes.fromhex(_required('KNOWLEDGE_NAMESPACE_HMAC_KEY')),embedding_model=_required('KNOWLEDGE_EMBEDDING_MODEL'),
        reranker_model=_required('KNOWLEDGE_RERANKER_MODEL'),answer_model=_required('KNOWLEDGE_ANSWER_MODEL'))
    consumer=Consumer({**kafka,'group.id':'greenguard-knowledge-local-dev-v1','enable.auto.commit':False,
        'enable.auto.offset.store':False,'auto.offset.reset':'earliest','max.poll.interval.ms':1800000})
    consumer.subscribe([TOPIC]);quarantine=Producer(kafka)
    print('local synthetic indexer active; gVisor validation is not included',flush=True)
    try:consume_forever(consumer,service,stop=stop,quarantine_producer=quarantine)
    finally:consumer.close()

if __name__=='__main__':main()
