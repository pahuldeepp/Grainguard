"""Real TLS JWKS + signed JWT + Postgres RLS/ACL HTTP acceptance.

Called by disposable postgres_acceptance. Keys/certificates are temporary,
trusted only by this test's HTTPS opener; production TLS stays strict.
"""
from datetime import datetime,timedelta,timezone
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.request import Request,urlopen,build_opener,HTTPSHandler
from urllib.error import HTTPError
import json,ssl,time
from uuid import uuid4
import jwt,psycopg
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from knowledge_extensions.oidc_auth import OidcAuthenticator,PostgresMemberships,NoRedirect
from knowledge_extensions.http_api import create_server
from knowledge_extensions.service import KnowledgeRagService
from knowledge_extensions.membership_provisioning import provision,MembershipConflict
from local_rag_adapters import LocalVectorStore,LocalEmbedding,LocalReranker,LocalAnswerGenerator
from pdf_fixture import make_text_pdf

A='11111111-1111-4111-8111-111111111111'
B='22222222-2222-4222-8222-222222222222'
P='88888888-8888-4888-8888-888888888888'
Q='99999999-9999-4999-8999-999999999999'
R='77777777-7777-4777-8777-777777777777'

def run(admin_dsn,app_dsn,models,object_store):
 provision_dsn=app_dsn.replace("knowledge_app:","knowledge_provisioner:")
 key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
 jwks=json.dumps({'keys':[json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))|{'kid':'local-1'}]}).encode()
 class Keys(BaseHTTPRequestHandler):
  def do_GET(self):
   self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(jwks)));self.end_headers();self.wfile.write(jwks)
  def log_message(self,*args):pass
 name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')]);now=datetime.now(timezone.utc)
 cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(hours=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]),critical=False).sign(key,hashes.SHA256())
 with TemporaryDirectory() as directory:
  root=Path(directory);(root/'key').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));(root/'key').chmod(0o600);(root/'cert').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
  tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(root/'cert',root/'key')
  issuer_server=ThreadingHTTPServer(('127.0.0.1',0),Keys);issuer_server.socket=tls.wrap_socket(issuer_server.socket,server_side=True)
  issuer_thread=Thread(target=issuer_server.serve_forever,daemon=True);issuer_thread.start()
  issuer=f'https://localhost:{issuer_server.server_port}'
  api=None
  try:
   with psycopg.connect(provision_dsn) as db:
    for subject,principal,role in [('owner',P,'operator'),('viewer',Q,'viewer'),('outsider',R,'operator')]:
     provision(db,tenant_id=A,issuer=issuer,subject=subject,principal_id=principal,roles=[role],active=True,expected_revision=0,actor_id=P,reason="synthetic acceptance")
   connect=lambda:psycopg.connect(app_dsn)
   auth=OidcAuthenticator(issuer=issuer,audience='knowledge',jwks_url=issuer+'/keys',memberships=PostgresMemberships(connect))
   auth._opener=build_opener(NoRedirect(),HTTPSHandler(context=ssl.create_default_context(cafile=str(root/'cert'))))
   service=KnowledgeRagService(connect=connect,vector_store=LocalVectorStore(),model_gateway=models,namespace_key=b'auth-acceptance-test-namespace-key-32-bytes',embedding_model=models.embedding_model,reranker_model=models.reranker_model,answer_model=models.answer_model,object_store=object_store)
   api=create_server(service=service,authenticator=auth,host='127.0.0.1',port=0);thread=Thread(target=api.serve_forever,daemon=True);thread.start()
   def token(subject,**changes):
    t=int(time.time());return jwt.encode({'iss':issuer,'aud':'knowledge','sub':subject,'iat':t,'exp':t+300,'role':'admin','tenant_id':B}|changes,key,algorithm='RS256',headers={'kid':'local-1'})
   def request(path,subject='owner',tenant=A,body=None,headers=None,expected=200):
    req=Request(f'http://127.0.0.1:{api.server_port}'+path,data=body,headers={'Authorization':'Bearer '+token(subject),'X-Tenant-ID':tenant}|(headers or {}))
    try:
     with urlopen(req,timeout=10) as response:status=response.status;payload=json.load(response)
    except HTTPError as error:status=error.code;payload=json.load(error)
    if status!=expected:raise AssertionError(f'auth acceptance expected {expected}, got {status}')
    return payload
   doc=str(uuid4());upload=request('/v1/documents/'+doc,body=make_text_pdf([['Storage','Keep wheat dry.']]),headers={'Content-Type':'application/pdf','X-Document-Version':'1'},expected=202)
   path=f'/v1/documents/{doc}/versions/1'
   request(path)
   service.process_document_event(tenant_id=A,document_id=doc,document_version=1,event_id=upload['event_id'])
   result=request('/v1/query',body=json.dumps({'question':'How should wheat be stored?'}).encode(),headers={'Content-Type':'application/json'})
   assert result.get('citations'), 'authenticated query has no grounded citation'
   request('/v1/query',tenant=B,body=json.dumps({'question':'How should wheat be stored?'}).encode(),headers={'Content-Type':'application/json'},expected=403)
   request(path,tenant=B,expected=403)
   request(path,subject='unknown',expected=403)
   with psycopg.connect(admin_dsn) as db:
    db.execute("SELECT set_config('app.tenant_id',%s,true)",(A,));db.execute("UPDATE knowledge_documents SET min_role='operator',acl_principals=%s WHERE tenant_id=%s AND document_id=%s",([P],A,doc));db.execute("UPDATE knowledge_document_versions SET min_role='operator',acl_principals=%s WHERE tenant_id=%s AND document_id=%s",([P],A,doc))
   request(path);request(path,subject='viewer',expected=404);request(path,subject='outsider',expected=404)
   with connect() as db:
    db.execute("SELECT set_config('app.tenant_id',%s,true)",(B,));assert db.execute('SELECT count(*) FROM knowledge_auth_memberships').fetchone()[0]==0
    try:
     with db.transaction():db.execute("UPDATE knowledge_auth_memberships SET active=true")
    except psycopg.errors.InsufficientPrivilege:pass
    else:raise AssertionError('runtime can mutate memberships')
   with psycopg.connect(provision_dsn) as db:
    provision(db,tenant_id=A,issuer=issuer,subject="owner",principal_id=P,roles=["operator"],active=False,expected_revision=1,actor_id=P,reason="synthetic revocation")
    try:
     provision(db,tenant_id=A,issuer=issuer,subject="owner",principal_id=P,roles=["admin"],active=True,expected_revision=1,actor_id=P,reason="stale update")
    except MembershipConflict:pass
    else:raise AssertionError("stale membership update accepted")
    db.execute("SELECT set_config('app.tenant_id',%s,true)",(A,));assert db.execute("SELECT count(*) FROM knowledge_membership_audit WHERE issuer=%s",(issuer,)).fetchone()[0]==4
   request(path,expected=403)
   with psycopg.connect(provision_dsn) as db:
    db.execute("SELECT set_config('app.tenant_id',%s,true)",(B,));assert db.execute('SELECT count(*) FROM knowledge_membership_audit').fetchone()[0]==0
    try:
     with db.transaction():db.execute('DELETE FROM knowledge_membership_audit')
    except psycopg.errors.InsufficientPrivilege:pass
    else:raise AssertionError('provisioner can delete audit history')
   print('AUTH_ACCEPTANCE_PASS: real TLS JWKS, signed JWT, authoritative memberships, forged role ignored, RLS, ACL, cross-tenant denial, runtime read-only, immediate revocation')
  finally:
   if api:api.shutdown();api.server_close();thread.join(timeout=2)
   issuer_server.shutdown();issuer_server.server_close();issuer_thread.join(timeout=2)
