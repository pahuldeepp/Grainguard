"""Explicit scoped historical-redaction maintenance; never runs at startup.

The protected scope file must be approved by the operator. This script preserves
original PDF retention and ACLs and emits normal durable indexing events.
"""
import json
import os
import stat
import psycopg
from knowledge_extensions.document_lifecycle import reindex_redacted_document
from knowledge_extensions.http_api import _canonical_uuid
from serve import _required


def main():
    path=_required('KNOWLEDGE_REDACTION_REINDEX_SCOPES_FILE')
    info=os.stat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)&0o077:
        raise SystemExit('reindex scope file must be a protected regular file')
    with open(path,encoding='utf-8') as handle:
        scopes=json.load(handle)
    if not isinstance(scopes,list) or not scopes or len(scopes)>1000 or any(
        not isinstance(scope,dict) or set(scope)!={'tenant_id','document_id','expected_version'}
        or not _canonical_uuid(scope['tenant_id']) or not _canonical_uuid(scope['document_id'])
        or type(scope['expected_version']) is not int or not 1<=scope['expected_version']<=2147483647
        for scope in scopes
    ):
        raise SystemExit('reindex scope requires bounded tenant/document/version objects')
    dsn=_required('KNOWLEDGE_DATABASE_URL')
    for scope in scopes:
        with psycopg.connect(dsn,connect_timeout=5,options='-c statement_timeout=10000 -c lock_timeout=2000') as connection:
            event=reindex_redacted_document(connection,**scope)
        print(json.dumps({'document_id':scope['document_id'],'document_version':scope['expected_version'],
                          'event_id':event,'status':'queued'}),flush=True)


if __name__=='__main__':main()
