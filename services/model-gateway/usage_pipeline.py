"""Content-free, at-least-once AI usage transport. PostgreSQL budgets stay truth."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone, date
import json
import os
from pathlib import Path
import re
import stat
import time
from uuid import UUID, uuid4

TOPIC = 'greenguard.ai-usage-settled.v1'
FIELDS = {'schema_version','tenant_id','attempt_id','principal_id','occurred_at','period',
          'model','provider','tokens','micros','usage_known'}


def validate(event, key=None):
    if not isinstance(event, dict) or set(event) != FIELDS or type(event['schema_version']) is not int or event['schema_version'] != 1:
        raise ValueError('invalid_usage_event')
    for field in ('tenant_id','principal_id'):
        value = event[field]
        if field == 'principal_id' and value == '':
            continue
        if not isinstance(value,str) or str(UUID(value)) != value:
            raise ValueError('invalid_usage_identity')
    for field in ('attempt_id','model','provider'):
        if not isinstance(event[field],str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', event[field]):
            raise ValueError('invalid_usage_metadata')
    if event['provider'] not in {'anthropic','voyage','legacy'}:
        raise ValueError('invalid_usage_provider')
    for field in ('tokens','micros'):
        if type(event[field]) is not int or not 0 <= event[field] <= 2**63-1:
            raise ValueError('invalid_usage_counter')
    if type(event['usage_known']) is not bool:
        raise ValueError('invalid_usage_known')
    stamp=datetime.fromisoformat(event['occurred_at'].replace('Z','+00:00'))
    if stamp.tzinfo is None or stamp.utcoffset().total_seconds() != 0:
        raise ValueError('invalid_usage_timestamp')
    if date.fromisoformat(event['period']).day != 1:
        raise ValueError('invalid_usage_period')
    if key is not None and key != event_key(event):
        raise ValueError('invalid_usage_key')
    return event


def event_key(event):
    return f"{event['tenant_id']}:{event['attempt_id']}"


def decode(message):
    value=message.value()
    if not isinstance(value,bytes) or len(value)>8192:
        raise ValueError('invalid_usage_size')
    try:
        return validate(json.loads(value), message.key().decode())
    except (AttributeError,TypeError,ValueError,UnicodeDecodeError) as exc:
        raise ValueError('invalid_usage_message') from exc


def canonical(row):
    attempt,principal,period,model,provider,tokens,micros,known,settled,payload = row
    event = dict(schema_version=1,tenant_id=None,attempt_id=attempt,principal_id=principal,
                 period=period.isoformat(),model=model,provider=provider,tokens=tokens,micros=micros,
                 usage_known=known,occurred_at=settled.astimezone(timezone.utc).isoformat())
    expected=dict(attempt_id=attempt,model=model,provider=provider,tokens=tokens,micros=micros,usage_known=known)
    if payload != expected:
        raise ValueError('usage_outbox_source_mismatch')
    return event


SOURCE = '''SELECT a.id,a.principal_id,a.period,a.model,a.provider,a.spent_tokens,a.spent_micros,
 a.usage_known,a.settled_at,o.payload FROM ai_budget_attempts a JOIN ai_usage_outbox o
 ON (a.tenant_id,a.id)=(o.tenant_id,o.id)
 WHERE a.tenant_id=%s AND a.id=%s AND a.state='settled' '''


def scope(conn, tenant, principal=''):
    conn.execute("SELECT set_config('app.tenant_id',%s,true)",(tenant,))
    conn.execute("SELECT set_config('app.principal_id',%s,true)",(principal,))


def publish_once(connect, producer, tenant, *, limit=100, lease_seconds=60, timeout=10):
    if type(limit) is not int or not 1<=limit<=100 or not 20<=lease_seconds<=300 or not 0<timeout<=10:
        raise ValueError('invalid_usage_relay_bounds')
    if str(UUID(tenant)) != tenant:
        raise ValueError('invalid_usage_tenant')
    # Claim individually: an entire batch must not expire while Kafka calls run.
    delivered=0
    for _ in range(limit):
        token=str(uuid4())
        with connect() as conn, conn.transaction():
            scope(conn,tenant)
            row=conn.execute('''WITH candidate AS (
             SELECT id FROM ai_usage_outbox WHERE tenant_id=%s AND published_at IS NULL
             AND (claimed_until IS NULL OR claimed_until<clock_timestamp())
             ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
             UPDATE ai_usage_outbox o SET claim_token=%s,claimed_until=clock_timestamp()+(%s*interval '1 second')
             FROM candidate c WHERE o.tenant_id=%s AND o.id=c.id RETURNING o.id''',
             (tenant,token,lease_seconds,tenant)).fetchone()
            if row is None:
                break
            source=conn.execute(SOURCE,(tenant,row[0])).fetchone()
            if source is None:
                raise ValueError('missing_settled_usage_source')
            event=canonical(source);event['tenant_id']=tenant;validate(event)
        acknowledged=[]
        try:
            producer.produce(TOPIC,key=event_key(event),value=json.dumps(event,separators=(',',':')),
                             on_delivery=lambda err,_msg:acknowledged.append(err is None))
            remaining=producer.flush(timeout)
            if remaining or acknowledged != [True]:
                raise RuntimeError('usage_kafka_delivery_unconfirmed')
            with connect() as conn, conn.transaction():
                scope(conn,tenant)
                changed=conn.execute('''UPDATE ai_usage_outbox SET published_at=clock_timestamp(),claim_token=NULL,claimed_until=NULL
                 WHERE tenant_id=%s AND id=%s AND claim_token=%s AND claimed_until>clock_timestamp()''',
                 (tenant,row[0],token)).rowcount
                if changed != 1:
                    raise RuntimeError('usage_outbox_lease_lost')
        except Exception:
            with connect() as conn, conn.transaction():
                scope(conn,tenant)
                conn.execute('''UPDATE ai_usage_outbox SET claim_token=NULL,claimed_until=NULL
                 WHERE tenant_id=%s AND id=%s AND claim_token=%s''',(tenant,row[0],token))
            raise
        delivered+=1
    return delivered


def apply_event(connect,event):
    validate(event)
    with connect() as conn, conn.transaction():
        scope(conn,event['tenant_id'],event['principal_id'])
        source=conn.execute(SOURCE,(event['tenant_id'],event['attempt_id'])).fetchone()
        if source is None:
            raise ValueError('missing_settled_usage_source')
        expected=canonical(source);expected['tenant_id']=event['tenant_id']
        # JSON timestamp spellings must not permit conflicting replay.
        normalized=dict(event,occurred_at=datetime.fromisoformat(event['occurred_at'].replace('Z','+00:00')).isoformat())
        if normalized != expected:
            raise ValueError('usage_source_mismatch')
        inserted=conn.execute('''INSERT INTO ai_usage_events
         (tenant_id,attempt_id,principal_id,occurred_at,period,model,provider,tokens,micros,usage_known)
         VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,attempt_id) DO NOTHING RETURNING attempt_id''',
         tuple(event[k] for k in ('tenant_id','attempt_id','principal_id','occurred_at','period','model','provider','tokens','micros','usage_known'))).fetchone()
        if inserted is None:
            return False
        conn.execute('''INSERT INTO ai_usage_daily
         (tenant_id,principal_id,usage_date,model,provider,attempts,tokens,micros,unknown_attempts)
         VALUES(%s,%s,%s,%s,%s,1,%s,%s,%s)
         ON CONFLICT(tenant_id,principal_id,usage_date,model,provider) DO UPDATE
         SET attempts=ai_usage_daily.attempts+1,tokens=ai_usage_daily.tokens+EXCLUDED.tokens,
         micros=ai_usage_daily.micros+EXCLUDED.micros,unknown_attempts=ai_usage_daily.unknown_attempts+EXCLUDED.unknown_attempts''',
         (event['tenant_id'],event['principal_id'],event['occurred_at'][:10],event['model'],event['provider'],
          event['tokens'],event['micros'],int(not event['usage_known'])))
    return True


def consume_once(connect,consumer,allowed_tenants, *, timeout=1):
    message=consumer.poll(timeout)
    if message is None:
        return None
    if message.error():
        raise RuntimeError('usage_kafka_poll_failed')
    if message.topic()!=TOPIC:
        raise ValueError('invalid_usage_topic')
    event=decode(message)
    if event['tenant_id'] not in allowed_tenants:
        raise PermissionError('usage_tenant_not_allowed')
    applied=apply_event(connect,event)
    # Commit only this record's partition offset after DB commit, synchronously.
    consumer.commit(message=message,asynchronous=False)
    return applied


def protected_json(path):
    source=Path(path)
    if not source.is_file() or stat.S_IMODE(source.stat().st_mode)&0o077:
        raise ValueError('usage_config_must_be_private')
    return json.loads(source.read_text())


def main():
    parser=argparse.ArgumentParser(description='AI usage relay/analytics worker; no provider calls.')
    parser.add_argument('mode',choices=['relay','consume'])
    parser.add_argument('--config-file',required=True)
    parser.add_argument('--once',action='store_true')
    args=parser.parse_args()
    config=protected_json(args.config_file)
    tenants=config['tenant_ids']
    if not isinstance(tenants,list) or not 1<=len(tenants)<=100 or any(not isinstance(t,str) or str(UUID(t))!=t for t in tenants):
        raise ValueError('invalid_usage_tenants')
    import psycopg
    from confluent_kafka import Producer,Consumer
    connect=lambda:psycopg.connect(config['database_url'])
    # Reject a privileged/migration-owner role before any work.
    with connect() as conn:
        unsafe=conn.execute("""SELECT rolsuper OR rolbypassrls OR EXISTS(
         SELECT 1 FROM pg_class WHERE relname IN('ai_usage_outbox','ai_budget_attempts','ai_usage_events','ai_usage_daily')
         AND pg_has_role(current_user,relowner,'USAGE')) FROM pg_roles WHERE rolname=current_user""").fetchone()[0]
        if unsafe:
            raise PermissionError('unsafe_usage_database_role')
    kafka=dict(config['kafka'])
    if args.mode=='relay':
        producer=Producer(kafka|{'acks':'all','enable.idempotence':True,'message.timeout.ms':10000})
        while True:
            for tenant in tenants:
                publish_once(connect,producer,tenant)
            if args.once:return
            time.sleep(1)
    else:
        consumer=Consumer(kafka|{'group.id':config['group_id'],'enable.auto.commit':False,
                                 'enable.auto.offset.store':False,'auto.offset.reset':'earliest'})
        consumer.subscribe([TOPIC])
        try:
            while True:
                consume_once(connect,consumer,set(tenants))
                if args.once:return
        finally:
            consumer.close()


if __name__=='__main__':
    try:
        main()
    except Exception:
        # Provider/database exception strings can contain connection secrets.
        raise SystemExit('AI_USAGE_WORKER_FAILED: inspect restricted runtime diagnostics')
