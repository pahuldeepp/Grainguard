"""Disposable Dex Authorization Code/PKCE -> signed JWKS -> RAG/RLS acceptance.

Uses synthetic local accounts and model/vector/object doubles; never prints tokens.
Set KNOWLEDGE_DEX_ACCEPTANCE=true for postgres_acceptance.py to include this gate.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4
import jwt
import psycopg
from knowledge_extensions.http_api import create_server
from knowledge_extensions.oidc_auth import OidcAuthenticator, PostgresMemberships
from knowledge_extensions.membership_provisioning import provision
from knowledge_extensions.service import KnowledgeRagService
from local_rag_adapters import LocalVectorStore
from pdf_fixture import make_text_pdf

ROOT=Path(__file__).resolve().parents[2]
A='a1111111-1111-4111-8111-111111111111'
B='b2222222-2222-4222-8222-222222222222'
P='66666666-6666-4666-8666-666666666666'
Q='55555555-5555-4555-8555-555555555555'


def run(admin_dsn, app_dsn, models, object_store):
    if os.environ.get('KNOWLEDGE_ENVIRONMENT')!='local-synthetic':
        raise RuntimeError('Dex acceptance requires local-synthetic environment')
    from local_dex import local_dex
    provision_dsn=app_dsn.replace('knowledge_app:','knowledge_provisioner:')
    api=None
    with local_dex() as fixture:
        issuer=fixture['issuer'];password=fixture['password'];discovery=fixture['discovery']
        env=dict(os.environ,OIDC_DEV_PASSWORD=password,OIDC_TOKEN_TTL='5m')
        try:
            source="""import {login} from './scripts/oidc-login.mjs';
const result={};
for(const user of ['alice','victor','bob']) {
const tokens=await login({email:user+'@greenguard.test',password:process.env.OIDC_DEV_PASSWORD});
result[user]=tokens.access_token;
}
const wrong=await login({email:'alice@greenguard.test',password:process.env.OIDC_DEV_PASSWORD,clientId:'greenguard-cli',redirectUri:'http://127.0.0.1:8765/callback'});
result.wrong=wrong.access_token;
process.stdout.write(JSON.stringify(result));"""
            login=subprocess.run(['node','--input-type=module','-e',source],cwd=ROOT,
                                 env=dict(env,OIDC_ISSUER=issuer),capture_output=True,text=True)
            if login.returncode:raise RuntimeError('Dex PKCE login failed')
            tokens=json.loads(login.stdout)
            connect=lambda:psycopg.connect(app_dsn)
            auth=OidcAuthenticator(issuer=issuer,audience='greenguard-dashboard',
                                  jwks_url=discovery['jwks_uri'],memberships=PostgresMemberships(connect),
                                  allow_local_http=True)
            # Verify the actual JWT before using its subject for trusted provisioning.
            identities={}
            for user in ('alice','victor','bob'):
                header=jwt.get_unverified_header(tokens[user])
                claims=jwt.decode(tokens[user],auth._key(header['kid']),algorithms=['RS256'],
                                  issuer=issuer,audience='greenguard-dashboard',
                                  options={'require':['iss','aud','sub','iat','exp']})
                identities[user]=claims['sub']
            with psycopg.connect(provision_dsn) as db:
                for user,principal,role in [('alice',P,'operator'),('victor',Q,'viewer')]:
                    provision(db,tenant_id=A,issuer=issuer,subject=identities[user],principal_id=principal,
                              roles=[role],active=True,expected_revision=0,actor_id=P,
                              reason='Dex synthetic acceptance',allow_local_http=True)
            service=KnowledgeRagService(connect=connect,vector_store=LocalVectorStore(),model_gateway=models,
                namespace_key=b'dex-local-acceptance-namespace-key-32-bytes',embedding_model=models.embedding_model,
                reranker_model=models.reranker_model,answer_model=models.answer_model,object_store=object_store)
            api=create_server(service=service,authenticator=auth,host='127.0.0.1',port=0)
            thread=Thread(target=api.serve_forever,daemon=True);thread.start()
            def request(path,user='alice',tenant=A,body=None,headers=None,expected=200):
                req=Request(f'http://127.0.0.1:{api.server_port}'+path,data=body,
                    headers={'Authorization':'Bearer '+tokens[user],'X-Tenant-ID':tenant,
                             'X-Role':'admin','X-Principal-ID':P}|(headers or {}))
                try:
                    with urlopen(req,timeout=10) as response:status=response.status;payload=json.load(response)
                except HTTPError as error:status=error.code;payload=json.load(error)
                if status!=expected:raise AssertionError(f'Dex {user} expected {expected}, got {status}')
                return payload
            doc=str(uuid4())
            uploaded=request('/v1/documents/'+doc,body=make_text_pdf([['Storage','Keep wheat dry.']]),
                headers={'Content-Type':'application/pdf','X-Document-Version':'1'},expected=202)
            service.process_document_event(tenant_id=A,document_id=doc,document_version=1,event_id=uploaded['event_id'])
            question=json.dumps({'question':'How should wheat be stored?'}).encode()
            result=request('/v1/query',body=question,headers={'Content-Type':'application/json'})
            assert any(c['document_id']==doc for c in result['citations'])
            path=f'/v1/documents/{doc}/versions/1'
            request(path,tenant=B,expected=403)
            request('/v1/query',tenant=B,body=question,headers={'Content-Type':'application/json'},expected=403)
            request(path,user='bob',expected=403)
            request(path,user='wrong',expected=401)
            with psycopg.connect(admin_dsn) as db:
                db.execute("SELECT set_config('app.tenant_id',%s,true)",(A,))
                for table in ('knowledge_documents','knowledge_document_versions'):
                    db.execute(f"UPDATE {table} SET min_role='operator',acl_principals=%s WHERE tenant_id=%s AND document_id=%s",([P],A,doc))
            request(path);request(path,user='victor',expected=404)
            viewer=request('/v1/query',user='victor',body=question,headers={'Content-Type':'application/json'})
            assert not viewer.get('citations'), 'viewer retrieved forbidden source'
            with psycopg.connect(provision_dsn) as db:
                provision(db,tenant_id=A,issuer=issuer,subject=identities['alice'],principal_id=P,
                          roles=['operator'],active=False,expected_revision=1,actor_id=P,
                          reason='Dex acceptance revoke',allow_local_http=True)
            request(path,expected=403)
            request('/v1/query',body=question,headers={'Content-Type':'application/json'},expected=403)
            print('DEX_RAG_ACCEPTANCE_PASS: real Dex code+PKCE login, access JWT/JWKS, shared dashboard audience, authoritative membership, grounded upload/query, wrong audience, no membership, forged headers, cross-tenant denial, ACL retrieval, immediate revocation')
        finally:
            if api:api.shutdown();api.server_close();thread.join(timeout=2)
