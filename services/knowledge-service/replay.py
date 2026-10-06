"""Requeue a quarantined indexing event under its tenant RLS context."""
import argparse
import os
from uuid import UUID
import psycopg

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--tenant',required=True)
    parser.add_argument('--event',required=True)
    args=parser.parse_args()
    for value in (args.tenant,args.event):
        if str(UUID(value)) != value:
            raise SystemExit('canonical UUID required')
    with psycopg.connect(os.environ['KNOWLEDGE_DATABASE_URL'],connect_timeout=5) as conn:
        with conn.transaction():
            conn.execute("SELECT set_config('app.tenant_id',%s,true)",(args.tenant,))
            event=conn.execute('''SELECT o.document_id,o.document_version,v.processing_status
                FROM knowledge_index_outbox o JOIN knowledge_document_versions v USING
                (tenant_id,document_id,document_version)
                WHERE o.tenant_id=%s AND o.event_id=%s FOR UPDATE OF o,v''',
                (args.tenant,args.event)).fetchone()
            if not event or event[2] != 'failed':
                raise SystemExit('event is not a failed document in this tenant')
            conn.execute('''UPDATE knowledge_document_versions SET processing_status=
                CASE WHEN EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.tenant_id=%s
                  AND c.document_id=%s AND c.document_version=%s) THEN 'parsed' ELSE 'queued' END
                WHERE tenant_id=%s AND document_id=%s AND document_version=%s''',
                (args.tenant,event[0],event[1],args.tenant,event[0],event[1]))
            conn.execute('''UPDATE knowledge_index_outbox SET processed_at=NULL,published_at=NULL,
                claim_token=NULL,claimed_until=NULL WHERE tenant_id=%s AND event_id=%s''',
                (args.tenant,args.event))
            conn.execute('DELETE FROM knowledge_index_failures WHERE tenant_id=%s AND event_id=%s',
                (args.tenant,args.event))
    print('Index event requeued; the outbox relay will publish it again.')

if __name__=='__main__': main()
