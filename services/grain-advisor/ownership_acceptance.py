"""Real owning Alerts HTTP + forced-RLS Advisor PostgreSQL proposal acceptance."""
import os,json,subprocess,time,threading
from pathlib import Path
from uuid import uuid4
from datetime import datetime,timedelta,timezone
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.request import Request,urlopen
from urllib.error import HTTPError
import psycopg,jwt
from psycopg import sql
from cryptography.hazmat.primitives.asymmetric import rsa
from advisor_security.alerts import AlertsOwnership
from advisor_security.delegated import DelegatedVerifier
from advisor_security.http_api import create_server
from migrate_security import apply
from security_acceptance import IMAGE

def run():
    root=Path(__file__).resolve().parents[2];token=uuid4().hex;tenant=str(uuid4());user=str(uuid4());current=['operator']
    class Membership(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            from urllib.parse import urlsplit,parse_qs
            query=parse_qs(urlsplit(self.path).query)
            if self.headers.get('Authorization')!='Bearer '+token:self.send_response(401);self.end_headers();return
            if not current:self.send_response(404);self.end_headers();return
            raw=json.dumps({'tenantId':query['tenantId'][0],'identityId':query['identityId'][0],'state':'active','roles':current,'version':1}).encode()
            self.send_response(200);self.end_headers();self.wfile.write(raw)
    membership=ThreadingHTTPServer(('127.0.0.1',0),Membership);threading.Thread(target=membership.serve_forever,daemon=True).start()
    name='gg-owner-acceptance-'+uuid4().hex[:8];password=uuid4().hex;owner=None;advisor=None
    def command(*args):return subprocess.check_output(args,text=True,stderr=subprocess.DEVNULL).strip()
    try:
        command('docker','run','-d','--name',name,'-e','POSTGRES_USER=advisor_migrator','-e','POSTGRES_PASSWORD='+password,'-e','POSTGRES_DB=greenguard_advisor','-p','127.0.0.1::5432',IMAGE)
        port=command('docker','port',name,'5432/tcp').rsplit(':',1)[1]
        admin=f'postgresql://advisor_migrator:{password}@127.0.0.1:{port}/greenguard_advisor';dsn=admin.replace('advisor_migrator:','advisor_app:')
        for _ in range(30):
            try:
                with psycopg.connect(admin,connect_timeout=1):break
            except psycopg.OperationalError:time.sleep(.5)
        with psycopg.connect(admin) as db:
            db.execute(sql.SQL('CREATE ROLE advisor_app LOGIN PASSWORD {} NOBYPASSRLS').format(sql.Literal(password)));apply(db)
        env={**os.environ,'GG_OWNER_TENANT':tenant,'GG_OWNER_TOKEN':token,'GG_OWNER_MEMBERSHIP_URL':f'http://127.0.0.1:{membership.server_port}'}
        owner=subprocess.Popen(['node','services/workflow-alerts/dist/testing/ownership-fixture.js'],cwd=root,env=env,stdout=subprocess.PIPE,text=True)
        fixture=json.loads(owner.stdout.readline())
        key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        verifier=DelegatedVerifier(issuer='https://delegation.test',audience='grain-advisor',scope='advisor:propose',key_resolver=lambda kid:key.public_key(),membership=lambda t,u:current if (t,u)==(tenant,user) else None)
        adapter=AlertsOwnership(fixture['origin'],token)
        advisor=create_server(connect=lambda:psycopg.connect(dsn),verifier=lambda scope:verifier,authorize_alert=adapter)
        threading.Thread(target=advisor.serve_forever,daemon=True).start()
        now=int(time.time())
        # Match the delegated verifier's closed scoped token contract.
        from advisor_security.delegated import DelegationError
        claims={'iss':'https://delegation.test','aud':'grain-advisor','sub':user,'tenant_id':tenant,'roles':['operator'],'scope':'advisor:propose','iat':now,'nbf':now,'act':{'sub':'grain-advisor'},'token_use':'delegated','exp':now+60,'jti':str(uuid4())}
        encoded=jwt.encode(claims,key,algorithm='RS256',headers={'kid':'key1','typ':'at+jwt'})
        def propose(alert,etag='"1"'):
            body=json.dumps({'run_id':str(uuid4()),'alert_id':alert,'etag':etag,'note':'Review requested'}).encode()
            try:
                with urlopen(Request(f'http://127.0.0.1:{advisor.server_port}/v1/advisor/proposals',data=body,headers={'Authorization':'Bearer '+encoded,'X-Tenant-ID':tenant,'Content-Type':'application/json'}),timeout=5) as response:return response.status,json.load(response)
            except HTTPError as error:return error.code,json.load(error)
        status,receipt=propose(fixture['alertId']);assert status==201,(status,receipt)
        with psycopg.connect(admin) as db:assert db.execute('SELECT count(*) FROM action_proposals WHERE proposal_id=%s',(receipt['proposal_id'],)).fetchone()[0]==1
        assert propose(fixture['alertId'],'"2"')[0]==404
        assert propose(str(uuid4()))[0]==404
        current.clear();assert propose(fixture['alertId'])[0] in {401,403}
        current.append('operator')
        # Membership revoked after successful owner lookup must be rechecked.
        def revoke_after_owner(*args):
            result=adapter(*args);current.clear();return result
        advisor.shutdown();advisor.server_close()
        advisor=create_server(connect=lambda:psycopg.connect(dsn),verifier=lambda scope:verifier,authorize_alert=revoke_after_owner)
        threading.Thread(target=advisor.serve_forever,daemon=True).start()
        assert propose(fixture['alertId'])[0] in {401,403}
        with psycopg.connect(admin) as db:
            assert db.execute('SELECT count(*) FROM action_proposals').fetchone()[0]==1
            assert db.execute('SELECT count(*) FROM advisor_security_outbox').fetchone()[0]==1
        print('OWNERSHIP_ACCEPTANCE_PASS: actual Alerts HTTP/RLS + current control membership HTTP + signed delegated Advisor HTTP + PostgreSQL persisted proposal; stale/missing/revoked denied')
    finally:
        if advisor:advisor.shutdown();advisor.server_close()
        if owner:owner.terminate();owner.wait(timeout=10)
        membership.shutdown();membership.server_close()
        command('docker','rm','-f',name)
if __name__=='__main__':run()
