"""Opt-in lifecycle worker; scoped tenant file and explicit retention policy."""
import json
import os
import signal
import stat
import threading

import psycopg
from knowledge_extensions.document_lifecycle import (
    enqueue_retention, process_cleanup, record_cleanup_failure, reconcile_uploads,
)
from knowledge_extensions.http_api import _canonical_uuid
from knowledge_extensions.object_storage import S3PdfObjectStore, S3SourceConfig
from knowledge_extensions.vector_store import PineconeVectorStore
from serve import _required, _provider_secret


def main():
    dsn=_required('KNOWLEDGE_DATABASE_URL')
    key=bytes.fromhex(_provider_secret('KNOWLEDGE_NAMESPACE_HMAC_KEY'))
    if len(key)<32:
        raise ValueError('namespace key must have at least 32 bytes')
    vectors=PineconeVectorStore(index_host=_required('PINECONE_INDEX_HOST'),
                               api_key=_provider_secret('PINECONE_API_KEY'))
    objects=S3PdfObjectStore(S3SourceConfig(bucket=_required('KNOWLEDGE_S3_BUCKET'),
      region=_required('KNOWLEDGE_S3_REGION'),kms_key_id=_required('KNOWLEDGE_S3_KMS_KEY_ID'),
      endpoint_url=os.environ.get('KNOWLEDGE_S3_ENDPOINT')))
    scopes=_required('KNOWLEDGE_LIFECYCLE_TENANTS_FILE')
    info=os.stat(scopes)
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError('lifecycle tenant file must be a protected regular file')
    # An absent policy disables source deletion. Do not invent a retention policy.
    policy=os.environ.get('KNOWLEDGE_DELETED_SOURCE_RETENTION_DAYS')
    days=int(policy) if policy else None
    if days is not None and not 1<=days<=3650:
        raise ValueError('explicit retention policy must be 1-3650 days')
    connect=lambda:psycopg.connect(dsn,connect_timeout=5,options='-c statement_timeout=10000 -c lock_timeout=2000')
    stop=threading.Event()
    signal.signal(signal.SIGTERM,lambda *_:stop.set())
    signal.signal(signal.SIGINT,lambda *_:stop.set())
    while not stop.is_set():
        with open(scopes,encoding='utf-8') as handle:
            tenants=json.load(handle)
        if not isinstance(tenants,list) or not tenants or any(not _canonical_uuid(t) for t in tenants):
            raise ValueError('lifecycle tenant file requires canonical UUIDs')
        for tenant in sorted(set(tenants)):
            if stop.is_set():
                break
            try:
                with connect() as connection:
                    reconcile_uploads(connection,tenant_id=tenant,object_store=objects)
                    if days is not None:
                        enqueue_retention(connection,tenant_id=tenant,retention_days=days)
                    with connection.transaction():
                        connection.execute("SELECT set_config('app.tenant_id',%s,true)",(tenant,))
                        jobs=connection.execute("""SELECT event_id::text FROM knowledge_lifecycle_outbox
                          WHERE tenant_id=%s AND completed_at IS NULL AND available_at<=clock_timestamp()
                            AND (operation!='source' OR %s)
                          ORDER BY available_at,event_id LIMIT 100""",(tenant,days is not None)).fetchall()
                for (event_id,) in jobs:
                    if stop.is_set():
                        break
                    try:
                        with connect() as connection:
                            process_cleanup(connection,tenant_id=tenant,event_id=event_id,
                              vector_store=vectors,object_store=objects,namespace_key=key,retention_days=days)
                    except Exception:
                        with connect() as connection:
                            record_cleanup_failure(connection,tenant_id=tenant,event_id=event_id)
                        print('knowledge lifecycle cleanup pending retry',flush=True)
            except Exception:
                print('knowledge lifecycle dependency unavailable',flush=True)
        stop.wait(5)


if __name__=='__main__':
    main()
