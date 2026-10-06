"""Cross-language BFF/Advisor signed-token and durable approval acceptance."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from threading import Thread
from uuid import uuid4
import psycopg
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from advisor_security.delegated import DelegatedVerifier
from advisor_security.http_api import create_server


def run(dsn,principal,alert,dex=None):
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    current=['operator']
    def membership(tenant,user):return current if (tenant,user)==(principal.tenant_id,principal.user_id) else None
    def verifier(scope):return DelegatedVerifier(issuer='https://delegation.test',audience='grain-advisor',scope=scope,key_resolver=lambda kid:key.public_key() if kid=='key1' else None,membership=membership)
    calls=[]
    def execute_action(p,action,owner_token,key):
        assert p.tenant_id==principal.tenant_id and action['target']==alert
        assert isinstance(owner_token,str) and owner_token.startswith('Bearer ')
        calls.append((action['target'],key))
        return {'status':200,'owner':'fixture','idempotency_key':key}
    server=create_server(connect=lambda:psycopg.connect(dsn),verifier=verifier,authorize_alert=lambda p,id,etag:(p.tenant_id==principal.tenant_id and id==alert and etag=='"v1"'),execute_action=execute_action)
    thread=Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix='gg-delegation-') as directory:
            path=Path(directory)/'fixture.json'
            config={'privatePem':key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode(),'tenant':principal.tenant_id,'user':principal.user_id,'run':str(uuid4()),'alert':alert,'request':str(uuid4()),'advisorURL':f'http://127.0.0.1:{server.server_port}'}
            if dex is not None:config['dex']={'issuer':dex['issuer'],'password':dex['password']}
            descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(descriptor,'w') as stream:json.dump(config,stream)
            root=Path(__file__).resolve().parents[2]
            env={**os.environ,'GG_DELEGATION_FIXTURE_FILE':str(path)}
            completed=subprocess.run(['node',str(root/'services/bff/dist/testing/delegated-fixture.js')],env=env,cwd=root,capture_output=True,text=True,timeout=30)
            if completed.returncode:raise AssertionError('BFF/Advisor delegated fixture failed')
            receipt=json.loads(completed.stdout);assert receipt['status']=='approved' and receipt['execution_status']=='succeeded'
            assert len(calls)==1
            with psycopg.connect(dsn) as db,db.transaction():
                db.execute("SELECT set_config('app.tenant_id',%s,true),set_config('app.user_id',%s,true),set_config('app.role','operator',true)",(principal.tenant_id,principal.user_id))
                row=db.execute('SELECT status,approver_id::text,execution_status,execution_attempts FROM action_proposals WHERE tenant_id=%s AND proposal_id=%s',(principal.tenant_id,receipt['proposal_id'])).fetchone()
                assert row==('approved',principal.user_id,'succeeded',1)
        print(('DEX_' if dex is not None else '')+'DELEGATED_BFF_ADVISOR_PASS: signed login, mapped membership, scoped decision and fresh owner token, real Postgres proposal/approval, one idempotent owner execution; no login-bearer forwarding')
    finally:server.shutdown();server.server_close();thread.join(timeout=3)
