"""Poll the durable Postgres summary queue for explicitly provisioned tenants."""
from __future__ import annotations
import os
import signal
import threading
import psycopg
from knowledge_extensions.model_gateway import ModelGatewayClient
from knowledge_extensions.summary_jobs import claim_summary_job, run_summary_job
from serve import _membership_authority, _required, _tenant_gateway_tokens


def process_once(connect, *, tenant, models, memberships, stop=None):
    with connect() as connection, connection.transaction():
        connection.execute("SELECT set_config('app.tenant_id',%s,true)",(tenant,))
        users = connection.execute('SELECT user_id::text FROM knowledge_summary_pending_principals(%s::uuid)',(tenant,)).fetchall()
    processed = 0
    for (user,) in users:
        if stop is not None and stop.is_set():
            break
        with connect() as connection:
            job = claim_summary_job(connection, tenant, user)
        if job:
            run_summary_job(connect, tenant=tenant, user=user, job=job, models=models, memberships=memberships, stop=stop)
            processed += 1
    return processed


def main():
    tokens = _tenant_gateway_tokens(_required('KNOWLEDGE_MODEL_GATEWAY_TOKENS_FILE'))
    dsn = _required('KNOWLEDGE_DATABASE_URL')
    connect = lambda: psycopg.connect(dsn,connect_timeout=5,options='-c statement_timeout=10000 -c lock_timeout=2000')
    models = ModelGatewayClient(base_url=_required('KNOWLEDGE_MODEL_GATEWAY_URL'),task_token=lambda tenant:tokens[tenant])
    memberships = _membership_authority(connect)
    stop = threading.Event()
    signal.signal(signal.SIGTERM,lambda *_:stop.set())
    signal.signal(signal.SIGINT,lambda *_:stop.set())
    while not stop.is_set():
        for tenant in tokens:
            if stop.is_set():
                break
            try:
                process_once(connect,tenant=tenant,models=models,memberships=memberships,stop=stop)
            except Exception:
                # No document/question/provider credentials enter logs.
                print('summary worker dependency unavailable',flush=True)
        stop.wait(2)


if __name__ == '__main__':
    main()
