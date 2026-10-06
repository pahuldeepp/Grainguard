"""Disposable isolated Advisor Postgres acceptance; no cloud or live actions."""
import os
from pathlib import Path
import subprocess
import time
from uuid import uuid4
from datetime import datetime,timedelta,timezone
from concurrent.futures import ThreadPoolExecutor
import psycopg
from psycopg import sql
from advisor_security.policy import Principal,PolicyDenied,TurnBudget
from advisor_security.proposals import propose,decide,scope,Conflict,NotFound
from advisor_security.tools import call
from migrate_security import apply as apply_migration
from unittest.mock import patch

IMAGE='postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'
HERE=Path(__file__).resolve().parent

def run():
    name='greenguard-advisor-security-'+str(uuid4())[:8];password=uuid4().hex
    def command(*args):return subprocess.check_output(args,text=True,stderr=subprocess.DEVNULL).strip()
    command('docker','run','-d','--name',name,'-e','POSTGRES_USER=advisor_migrator','-e','POSTGRES_PASSWORD='+password,'-e','POSTGRES_DB=greenguard_advisor','-p','127.0.0.1::5432',IMAGE)
    try:
        port=command('docker','port',name,'5432/tcp').rsplit(':',1)[1]
        admin=f'postgresql://advisor_migrator:{password}@127.0.0.1:{port}/greenguard_advisor'
        app=f'postgresql://advisor_app:{password}@127.0.0.1:{port}/greenguard_advisor'
        for _ in range(30):
            try:
                with psycopg.connect(admin,connect_timeout=1):break
            except psycopg.OperationalError:time.sleep(.5)
        else:raise RuntimeError("disposable Advisor PostgreSQL did not become ready")
        with psycopg.connect(admin) as db:
            try:apply_migration(db)
            except ValueError:pass
            else:raise AssertionError('migration accepted missing runtime role')
            db.execute(sql.SQL("CREATE ROLE advisor_app LOGIN PASSWORD {} NOBYPASSRLS").format(sql.Literal(password)))
            apply_migration(db)
            apply_migration(db)
        tenant,user=str(uuid4()),str(uuid4());expiry=datetime.now(timezone.utc)+timedelta(minutes=5)
        operator=Principal(tenant,user,'operator','grain-advisor',expiry)
        foreign=Principal(str(uuid4()),str(uuid4()),'operator','grain-advisor',expiry)
        args={'alert_id':str(uuid4()),'note':'Contact fixture@example.invalid for review','etag':'"v1"'};run_id=str(uuid4())
        with psycopg.connect(app) as db:
            item=propose(db,operator,run_id,args)
            assert propose(db,operator,run_id,args)==item
            try:decide(db,foreign,item['proposal_id'],decision='approved',action_hash=item['action_hash'],version=1,request_id=str(uuid4()))
            except NotFound:pass
            else:raise AssertionError('foreign tenant saw proposal')
            try:decide(db,Principal(tenant,user,'viewer','grain-advisor',expiry),item['proposal_id'],decision='approved',action_hash=item['action_hash'],version=1,request_id=str(uuid4()))
            except PolicyDenied:pass
            else:raise AssertionError('viewer approved')
            try:decide(db,operator,item['proposal_id'],decision='approved',action_hash='0'*64,version=1,request_id=str(uuid4()))
            except Conflict:pass
            else:raise AssertionError('changed action approved')
        request_id=str(uuid4())
        def approve(_):
            with psycopg.connect(app) as db:return decide(db,operator,item['proposal_id'],decision='approved',action_hash=item['action_hash'],version=1,request_id=request_id)
        with ThreadPoolExecutor(max_workers=6) as pool:results=list(pool.map(approve,range(6)))
        assert all(r==results[0] for r in results)
        with psycopg.connect(app) as db:
            executions=[]
            def execute_action(principal,action,owner_token,execution_key):
                assert owner_token=='Bearer '+('o'*48)
                assert execution_key
                executions.append((principal.tenant_id,action['target'],execution_key))
                return {'status':200,'owner':'fixture','target':action['target']}
            executed=decide(db,operator,item['proposal_id'],decision='approved',action_hash=item['action_hash'],version=1,request_id=request_id,execute_action=execute_action,owner_token='Bearer '+('o'*48))
            assert executed['execution_status']=='succeeded' and len(executions)==1
            replay=decide(db,operator,item['proposal_id'],decision='approved',action_hash=item['action_hash'],version=1,request_id=request_id,execute_action=execute_action,owner_token='Bearer '+('o'*48))
            assert replay['execution_status']=='succeeded' and len(executions)==1
            with db.transaction():
                scope(db,operator)
                row=db.execute('SELECT execution_status,execution_attempts FROM action_proposals WHERE tenant_id=%s AND proposal_id=%s',(tenant,item['proposal_id'])).fetchone()
            assert row==('succeeded',1), row
            try:decide(db,operator,item['proposal_id'],decision='rejected',action_hash=item['action_hash'],version=1,request_id=request_id)
            except Conflict:pass
            else:raise AssertionError('idempotency key rebound')
            second=propose(db,operator,str(uuid4()),args)
        def race(_):
            try:
                with psycopg.connect(app) as db:decide(db,operator,second['proposal_id'],decision='approved',action_hash=second['action_hash'],version=1,request_id=str(uuid4()))
                return 1
            except Conflict:return 0
        with ThreadPoolExecutor(max_workers=6) as pool:assert sum(pool.map(race,range(6)))==1
        with psycopg.connect(app) as db:
            expired=propose(db,operator,str(uuid4()),args)
            with psycopg.connect(admin) as fixture:
                fixture.execute("UPDATE action_proposals SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=%s AND proposal_id=%s",(tenant,expired['proposal_id']))
            expiry_request=str(uuid4())
            try:decide(db,operator,expired['proposal_id'],decision='approved',action_hash=expired['action_hash'],version=1,request_id=expiry_request)
            except Conflict as e:assert str(e)=='proposal_expired'
            else:raise AssertionError('expired approved')
            try:decide(db,operator,expired['proposal_id'],decision='approved',action_hash=expired['action_hash'],version=1,request_id=expiry_request)
            except Conflict as e:assert str(e)=='proposal_expired'
            else:raise AssertionError('expired retry changed result')
            for column,value in [('action_hash','0'*64),('user_id',str(uuid4()))]:
                try:
                    with db.transaction():scope(db,operator);db.execute('UPDATE action_proposals SET '+column+'=%s WHERE tenant_id=%s AND proposal_id=%s',(value,tenant,item['proposal_id']))
                except psycopg.errors.InsufficientPrivilege:pass
                else:raise AssertionError('runtime can mutate approved payload')
            policy=__import__('advisor_security.policy',fromlist=['load_policy']).load_policy()
            policy['tools']['propose_acknowledge_alert']['four_eyes']=True
            four=propose(db,operator,str(uuid4()),args)
            with patch('advisor_security.proposals.load_policy',return_value=policy):
                try:decide(db,operator,four['proposal_id'],decision='approved',action_hash=four['action_hash'],version=1,request_id=str(uuid4()))
                except PolicyDenied:pass
                else:raise AssertionError('four-eyes self approval accepted')
                other=Principal(tenant,str(uuid4()),'operator','grain-advisor',expiry)
                assert decide(db,other,four['proposal_id'],decision='rejected',action_hash=four['action_hash'],version=1,request_id=str(uuid4()))['status']=='rejected'
            read=Principal(tenant,user,'viewer','knowledge-service',expiry)
            captured=[]
            def knowledge(principal,query,k):
                captured.append((principal.tenant_id,principal.user_id,query,k));return {'answer':'fixture','citations':[],'retrieval':{}}
            result=call(db,read,TurnBudget(read,str(uuid4())),'search_knowledge',{'query':'Wheat storage?','k':5},knowledge=knowledge)
            assert result=={'answer':'fixture','citations':[],'retrieval':{}} and captured[0][:2]==(tenant,user)
            calls=[]
            try:call(db,operator,TurnBudget(operator,str(uuid4())),'shell',{'command':'unsafe'},knowledge=lambda *args:calls.append(args))
            except PolicyDenied:pass
            else:raise AssertionError('unknown tool accepted')
            assert calls==[]
            with db.transaction():
                scope(db,operator)
                audit_rows=db.execute('SELECT kind,tool FROM advisor_security_audit WHERE tenant_id=%s',(tenant,)).fetchall()
                assert len(audit_rows)==db.execute('SELECT count(*) FROM advisor_security_outbox WHERE tenant_id=%s',(tenant,)).fetchone()[0]
                assert ('expired','propose_acknowledge_alert') in audit_rows
                assert ('tool_denied','unknown') in audit_rows
                assert 'fixture@example.invalid' not in str(db.execute('SELECT payload FROM advisor_security_outbox WHERE tenant_id=%s',(tenant,)).fetchall())
            for table in ['advisor_security_audit','advisor_security_outbox','advisor_decision_receipts']:
                try:
                    with db.transaction():scope(db,operator);db.execute('DELETE FROM '+table+' WHERE tenant_id=%s',(tenant,))
                except psycopg.errors.InsufficientPrivilege:pass
                else:raise AssertionError('runtime can delete immutable records')
            with db.transaction():
                scope(db,foreign)
                for table in ['action_proposals','advisor_security_audit','advisor_security_outbox','advisor_decision_receipts']:
                    assert db.execute('SELECT count(*) FROM '+table+' WHERE tenant_id=%s',(tenant,)).fetchone()[0]==0
        # Failure to persist either audit/outbox rolls back the proposal too.
        blocked_run=str(uuid4())
        with psycopg.connect(admin) as owner:owner.execute('REVOKE INSERT ON advisor_security_outbox FROM advisor_app')
        try:
            with psycopg.connect(app) as db:propose(db,operator,blocked_run,args)
        except psycopg.errors.InsufficientPrivilege:pass
        else:raise AssertionError('proposal committed without outbox')
        with psycopg.connect(admin) as owner:
            assert owner.execute('SELECT count(*) FROM action_proposals WHERE tenant_id=%s AND run_id=%s',(tenant,blocked_run)).fetchone()[0]==0
            assert owner.execute('SELECT count(*) FROM advisor_security_audit a LEFT JOIN advisor_security_outbox o USING(tenant_id,event_id) WHERE o.event_id IS NULL').fetchone()[0]==0
        with psycopg.connect(admin) as owner:owner.execute('GRANT INSERT ON advisor_security_outbox TO advisor_app')
        # Real signed login -> BFF membership mapping -> scoped token -> Python
        # receiver -> real Advisor Postgres proposal/decision. No live IdP/cloud.
        from delegated_acceptance import run as run_delegated_acceptance
        run_delegated_acceptance(app,operator,args['alert_id'])
        if os.environ.get('ADVISOR_DEX_ACCEPTANCE')=='1':
            import sys
            sys.path.insert(0,str(HERE.parents[1]/'services/knowledge-service'))
            from local_dex import local_dex
            with local_dex() as dex:
                run_delegated_acceptance(app,operator,args['alert_id'],dex=dex)
        print('ADVISOR_SECURITY_PASS: role/audience/tenant denial, exact action hash, optimistic races, idempotent decisions, expiry, immutable audit+atomic outbox, owner execution with deterministic idempotency and receipt')
    finally:command('docker','rm','-f',name)

if __name__=='__main__':run()
