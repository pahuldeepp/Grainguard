"""Disposable real PostgreSQL + Kafka acceptance; never changes shared runtimes."""
import hashlib
import json
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import psycopg
from confluent_kafka import Producer,Consumer
from confluent_kafka.admin import AdminClient,NewTopic
from usage_pipeline import TOPIC,SOURCE,canonical,scope,publish_once,apply_event,consume_once,event_key

ROOT=Path(__file__).resolve().parent
T='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';U='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
V='cccccccc-cccc-4ccc-8ccc-cccccccccccc';OTHER='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
KAFKA_IMAGE='apache/kafka@sha256:4ceccc577f03f51f6af8dbfda55194d0d892f4fa7913ffbded567ce3895622ed'
POSTGRES_IMAGE='postgres@sha256:721873c34ceb9f65c9d9698913138f29403332328653968757b07eb719706ba112'
# Resolve an already installed immutable local PostgreSQL image. No registry pulls.
POSTGRES_IMAGE='sha256:721873c34ceb'  # docker accepts the local immutable image ID prefix
suffix=secrets.token_hex(6); pg='gg-ai-usage-pg-'+suffix;kafka='gg-ai-usage-kafka-'+suffix
password=secrets.token_hex(24); created=[];checks=[]

def command(args):
    return subprocess.check_output(args,text=True,stderr=subprocess.DEVNULL).strip()


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));return sock.getsockname()[1]


def assert_check(name,condition):
    if not condition:raise AssertionError(name)
    checks.append(name)


def wait_connect(dsn):
    deadline=time.monotonic()+40
    while time.monotonic()<deadline:
        try:return psycopg.connect(dsn)
        except psycopg.OperationalError:time.sleep(.25)
    raise RuntimeError('disposable_postgres_not_ready')


def consume_until(connect,consumer,expected, *, fail_connect=None):
    deadline=time.monotonic()+30;observed=[]
    while len(observed)<expected and time.monotonic()<deadline:
        result=consume_once(fail_connect or connect,consumer,{T,OTHER},timeout=.5)
        if result is not None:observed.append(result)
    if len(observed)!=expected:raise AssertionError('kafka_records_missing')
    return observed


def main(output):
    pgport=free_port();kport=free_port()
    command(['docker','run','-d','--pull=never','--name',pg,'-e','POSTGRES_PASSWORD='+password,
             '-p',f'127.0.0.1:{pgport}:5432',POSTGRES_IMAGE]);created.append(pg)
    dsn=f'postgresql://postgres:{password}@127.0.0.1:{pgport}/postgres'
    with wait_connect(dsn) as conn:
        conn.execute("CREATE ROLE model_gateway_app NOSUPERUSER NOBYPASSRLS")
        conn.execute(f"CREATE ROLE model_gateway_usage_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '{password}'")
        conn.execute((ROOT/'migrations/001_budget.sql').read_text())
        conn.execute((ROOT/'migrations/002_usage_analytics.sql').read_text())
        # Synthetic settled source records; budgets are not altered by transport.
        for tenant,attempt,principal,tokens,micros,known in [(T,'one',U,10,20,True),(T,'two',U,30,40,False),
                                                         (T,'three',V,5,6,True),(OTHER,'one',U,7,8,True)]:
            conn.execute('''INSERT INTO ai_budget_attempts
             (tenant_id,id,principal_id,model,provider,period,reserved_micros,reserved_tokens,state,
              spent_micros,spent_tokens,usage_known,settled_at)
             VALUES(%s,%s,%s,'answer-v1','anthropic','2026-10-01',100,100,'settled',%s,%s,%s,'2026-10-04T12:00:00Z')''',
             (tenant,attempt,principal,micros,tokens,known))
            payload=dict(attempt_id=attempt,model='answer-v1',provider='anthropic',tokens=tokens,micros=micros,usage_known=known)
            conn.execute('INSERT INTO ai_usage_outbox(tenant_id,id,payload) VALUES(%s,%s,%s::jsonb)',
                         (tenant,attempt,json.dumps(payload)))
    runtime=f'postgresql://model_gateway_usage_app:{password}@127.0.0.1:{pgport}/postgres'
    connect=lambda:psycopg.connect(runtime)
    with connect() as conn,conn.transaction():
        scope(conn,T,U)
        assert_check('outbox_tenant_rls',conn.execute('SELECT count(*) FROM ai_usage_outbox').fetchone()[0]==3)
        assert_check('explicit_foreign_predicate_denied',conn.execute('SELECT count(*) FROM ai_usage_outbox WHERE tenant_id=%s',(OTHER,)).fetchone()[0]==0)
        event=canonical(conn.execute(SOURCE,(T,'one')).fetchone());event['tenant_id']=T
    with connect() as conn:
        try:
            conn.execute('UPDATE ai_budget_accounts SET spent_micros=0')
        except psycopg.errors.InsufficientPrivilege:checks.append('worker_cannot_modify_budget_truth')
        else:raise AssertionError('budget_mutation_allowed')
    command(['docker','run','-d','--pull=never','--name',kafka,'--hostname',kafka,'-p',f'127.0.0.1:{kport}:9092',
             '-e','KAFKA_NODE_ID=1','-e','KAFKA_PROCESS_ROLES=broker,controller',
             '-e','KAFKA_LISTENERS=HOST://:9092,CONTROLLER://:9093',
             '-e',f'KAFKA_ADVERTISED_LISTENERS=HOST://127.0.0.1:{kport}',
             '-e','KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=HOST:PLAINTEXT,CONTROLLER:PLAINTEXT',
             '-e','KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER','-e','KAFKA_INTER_BROKER_LISTENER_NAME=HOST',
             '-e',f'KAFKA_CONTROLLER_QUORUM_VOTERS=1@{kafka}:9093',
             '-e','KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1','-e','KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0',
             '-e','KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1','-e','KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1',
             '-e','KAFKA_AUTO_CREATE_TOPICS_ENABLE=false','-e','KAFKA_HEAP_OPTS=-Xms128m -Xmx256m',KAFKA_IMAGE]);created.append(kafka)
    broker=f'127.0.0.1:{kport}'
    admin=AdminClient({'bootstrap.servers':broker,'log_level':0})
    deadline=time.monotonic()+40
    while time.monotonic()<deadline:
        try:
            admin.list_topics(timeout=1);break
        except Exception:time.sleep(.5)
    else:raise RuntimeError('disposable_kafka_not_ready')
    for future in admin.create_topics([NewTopic(TOPIC,num_partitions=1,replication_factor=1)]).values():future.result(10)
    producer=Producer({'bootstrap.servers':broker,'enable.idempotence':True,'acks':'all','message.timeout.ms':10000,'log_level':0})
    # An actual Kafka outage leaves the outbox retryable, never falsely published.
    broken=Producer({'bootstrap.servers':'127.0.0.1:1','message.timeout.ms':1000,'log_level':0})
    try:publish_once(connect,broken,T,limit=1,timeout=.2)
    except RuntimeError:pass
    else:raise AssertionError('outage_reported_as_delivery')
    broken.flush(2)
    with connect() as conn,conn.transaction():
        scope(conn,T)
        pending=conn.execute('SELECT count(*) FROM ai_usage_outbox WHERE tenant_id=%s AND published_at IS NULL AND claim_token IS NULL',(T,)).fetchone()[0]
        assert_check('kafka_outage_releases_claim_and_keeps_pending',pending==3)
    # Simulate delivery success then a process failure before DB acknowledgement.
    calls=[0]
    def crash_after_send():
        calls[0]+=1
        if calls[0]==2:raise RuntimeError('synthetic_process_crash_before_ack')
        return connect()
    try:publish_once(crash_after_send,producer,T,limit=1)
    except RuntimeError:checks.append('publish_success_before_db_mark_is_retryable')
    else:raise AssertionError('crash_injection_missed')
    assert_check('real_kafka_relay_delivers_pending',publish_once(connect,producer,T)==3)
    assert_check('other_tenant_same_attempt_id_delivered',publish_once(connect,producer,OTHER)==1)
    assert_check('already_published_outbox_not_relayed',publish_once(connect,producer,T)==0)
    # Consumer DB outage leaves broker offset uncommitted, enabling restart/replay.
    group='gg-ai-usage-acceptance-'+suffix
    config={'bootstrap.servers':broker,'group.id':group,'enable.auto.commit':False,
            'enable.auto.offset.store':False,'auto.offset.reset':'earliest','log_level':0}
    consumer=Consumer(config);consumer.subscribe([TOPIC])
    def outage():raise RuntimeError('synthetic_database_outage')
    try:consume_until(connect,consumer,1,fail_connect=outage)
    except RuntimeError:checks.append('consumer_database_outage_does_not_ack')
    else:raise AssertionError('database_outage_not_exercised')
    finally:consumer.close()
    # DB commits then offset commit fails: new consumer replays without double count.
    real=Consumer(config);real.subscribe([TOPIC])
    class CommitFailure:
        def poll(self,timeout):return real.poll(timeout)
        def commit(self,**kwargs):raise RuntimeError('synthetic_offset_commit_failure')
    try:consume_until(connect,CommitFailure(),1)
    except RuntimeError:checks.append('database_commit_before_offset_failure_replays')
    else:raise AssertionError('offset_failure_not_exercised')
    finally:real.close()
    consumer=Consumer(config);consumer.subscribe([TOPIC])
    try:
        observed=consume_until(connect,consumer,5)
        assert_check('replay_and_duplicate_do_not_double_count',observed.count(False)==2 and observed.count(True)==3)
    finally:consumer.close()
    # Canonical-source verification rejects tampering before deduplication.
    for forged in (dict(event,tokens=999),dict(event,principal_id=V),dict(event,model='forged-model')):
        try:apply_event(connect,forged)
        except ValueError:pass
        else:raise AssertionError('forged_usage_accepted')
    checks.append('conflicting_replay_rejected_against_settled_truth')
    with connect() as conn,conn.transaction():
        scope(conn,T,U)
        rows=conn.execute('SELECT attempts,tokens,micros,unknown_attempts FROM ai_usage_daily WHERE tenant_id=%s AND principal_id=%s',(T,U)).fetchall()
        assert_check('unknown_usage_counted_once_as_reserved_charge',rows==[(2,40,60,1)])
        assert_check('principal_rls_blocks_other_principal',conn.execute('SELECT count(*) FROM ai_usage_events WHERE principal_id=%s',(V,)).fetchone()[0]==0)
        assert_check('tenant_rls_blocks_foreign_analytics',conn.execute('SELECT count(*) FROM ai_usage_daily WHERE tenant_id=%s',(OTHER,)).fetchone()[0]==0)
        # Aggregate-write failure must also roll back the dedup ledger insert.
    with psycopg.connect(dsn) as conn:
        # Fourth source event for atomic rollback control.
        conn.execute("INSERT INTO ai_budget_attempts SELECT tenant_id,'rollback',principal_id,model,provider,period,reserved_micros,reserved_tokens,state,spent_micros,spent_tokens,usage_known,created_at,settled_at FROM ai_budget_attempts WHERE tenant_id=%s AND id='one'",(T,))
        payload=dict(attempt_id='rollback',model='answer-v1',provider='anthropic',tokens=10,micros=20,usage_known=True)
        conn.execute('INSERT INTO ai_usage_outbox(tenant_id,id,payload) VALUES(%s,%s,%s::jsonb)',(T,'rollback',json.dumps(payload)))
        conn.execute("CREATE FUNCTION fail_usage_aggregate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_aggregate_outage'; END $$")
        conn.execute('CREATE TRIGGER fail_usage BEFORE INSERT OR UPDATE ON ai_usage_daily FOR EACH ROW EXECUTE FUNCTION fail_usage_aggregate()')
    rollback=dict(event,attempt_id='rollback')
    try:apply_event(connect,rollback)
    except psycopg.errors.RaiseException:pass
    else:raise AssertionError('aggregate_failure_not_exercised')
    with connect() as conn,conn.transaction():
        scope(conn,T,U)
        assert_check('aggregate_failure_rolls_back_dedup_ledger',conn.execute("SELECT count(*) FROM ai_usage_events WHERE tenant_id=%s AND attempt_id='rollback'",(T,)).fetchone()[0]==0)
    with psycopg.connect(dsn) as conn:conn.execute('DROP TRIGGER fail_usage ON ai_usage_daily')
    assert_check('rolled_back_record_can_be_replayed',apply_event(connect,rollback))
    report=dict(passed=True,checks=checks,transport='real_disposable_kafka',database='real_disposable_postgresql',
                delivery='at_least_once',billing_truth='PostgreSQL budget accounts and settled attempts; no consumer spend mutations',
                aggregation='eventually_consistent_deduplicated_usage',production_acceptance=False,
                migration_sha256=hashlib.sha256((ROOT/'migrations/002_usage_analytics.sql').read_bytes()).hexdigest())
    destination=Path(output);destination.mkdir(parents=True,exist_ok=True)
    (destination/'usage-acceptance.json').write_text(json.dumps(report,indent=2)+'\n')
    print('AI_USAGE_ACCEPTANCE_PASS: '+json.dumps({'checks':len(checks)}))


if __name__=='__main__':
    try:main(sys.argv[1])
    except Exception as exc:
        # Never log raw PostgreSQL/Kafka exceptions or generated connection URLs.
        print('AI_USAGE_ACCEPTANCE_FAILED: '+type(exc).__name__)
        raise SystemExit(1)
    finally:
        for name in reversed(created):
            subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
