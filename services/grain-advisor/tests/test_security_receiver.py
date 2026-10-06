import os
import http.client
import json
import ssl
import socket
import tempfile
import threading
import time
import unittest
from datetime import datetime,timedelta,timezone
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4
import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from urllib.request import build_opener,HTTPSHandler
from advisor_security.delegated import DelegatedVerifier,DelegationError
from advisor_security.http_api import create_server
from advisor_security.jwks import PublicJwks,NoRedirect
from advisor_security.membership import ControlPlaneMemberships


class ReceiverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        cls.temp=tempfile.TemporaryDirectory()
        name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])
        now=datetime.now(timezone.utc)
        cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(cls.key.public_key())
              .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1))
              .not_valid_after(now+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]),False)
              .sign(cls.key,hashes.SHA256()))
        cert_path=Path(cls.temp.name)/'cert.pem';key_path=Path(cls.temp.name)/'key.pem'
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(cls.key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
        cls.trust=ssl.create_default_context(cafile=str(cert_path));cls.cert_path=str(cert_path)
        cls.jwk={**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(cls.key.public_key())), 'kid':'key1','alg':'RS256','use':'sig'}
        class Owner(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                cls.requests.append((self.path,self.headers.get('Authorization')))
                if self.path=='/jwks':status,body=200,cls.document
                elif self.path=='/redirect':
                    self.send_response(302);self.send_header('Location','/jwks');self.end_headers();return
                else:status,body=cls.owner_status,cls.owner_body
                raw=json.dumps(body).encode();self.send_response(status);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        cls.owner=ThreadingHTTPServer(('127.0.0.1',0),Owner)
        ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(str(cert_path),str(key_path))
        cls.owner.socket=ctx.wrap_socket(cls.owner.socket,server_side=True)
        cls.thread=threading.Thread(target=cls.owner.serve_forever,daemon=True);cls.thread.start()
        cls.url=f'https://localhost:{cls.owner.server_port}'
    @classmethod
    def tearDownClass(cls):
        cls.owner.shutdown();cls.owner.server_close();cls.thread.join();cls.temp.cleanup()
    def setUp(self):
        self.__class__.requests=[];self.__class__.document={'keys':[self.jwk]}
        self.tenant=str(uuid4());self.user=str(uuid4())
        self.__class__.owner_status=200
        self.__class__.owner_body={'tenantId':self.tenant,'identityId':self.user,'state':'active','roles':['operator']}
        self.keys=PublicJwks(self.url+'/jwks');self.keys.opener=build_opener(NoRedirect(),HTTPSHandler(context=self.trust))
        self.member=ControlPlaneMemberships(self.url,'internal-owner-token')
        environment=patch.dict(os.environ,{'SSL_CERT_FILE':self.cert_path});environment.start();self.addCleanup(environment.stop)
        self.verifier=DelegatedVerifier(issuer='https://issuer.test',audience='grain-advisor',scope='advisor:propose',key_resolver=self.keys,membership=self.member)
        now=int(time.time())
        claims={'iss':'https://issuer.test','aud':'grain-advisor','sub':self.user,'tenant_id':self.tenant,'roles':['operator'],'act':{'sub':'grain-advisor'},'scope':'advisor:propose','token_use':'delegated','iat':now,'nbf':now,'exp':now+120,'jti':str(uuid4())}
        self.token='Bearer '+jwt.encode(claims,self.key,algorithm='RS256',headers={'typ':'at+jwt','kid':'key1'})
    def test_real_https_jwks_owner_and_revocation(self):
        self.assertEqual(self.verifier.verify(self.token,self.tenant).role,'operator')
        self.verifier.verify(self.token,self.tenant)
        self.assertEqual(sum(path=='/jwks' for path,_ in self.requests),1)
        self.assertTrue(all(auth=='Bearer internal-owner-token' for path,auth in self.requests if path!='/jwks'))
        self.owner_body['roles']=['viewer']
        with self.assertRaises(DelegationError) as err:self.verifier.verify(self.token,self.tenant)
        self.assertEqual(err.exception.status,403)
        self.__class__.owner_status=404
        with self.assertRaises(DelegationError) as err:self.verifier.verify(self.token,self.tenant)
        self.assertEqual(err.exception.status,403)
    def test_owner_device_role_is_known_but_cannot_authorize_delegation(self):
        for roles,status in [(['device'],403),(['unknown'],503),(['device','operator'],200)]:
            self.owner_body['roles']=roles
            if status==200:self.assertEqual(self.verifier.verify(self.token,self.tenant).role,'operator')
            else:
                with self.assertRaises(DelegationError) as err:self.verifier.verify(self.token,self.tenant)
                self.assertEqual(err.exception.status,status)

    def test_owner_outage_and_cross_tenant_fail_closed(self):
        for status,body in [(503,{}),(200,{**self.owner_body,'tenantId':str(uuid4())}),(200,{**self.owner_body,'state':'revoked'})]:
            self.__class__.owner_status=status;self.__class__.owner_body=body
            with self.assertRaises(DelegationError) as err:self.verifier.verify(self.token,self.tenant)
            self.assertEqual(err.exception.status,503)
    def test_jwks_redirect_private_duplicate_and_untrusted_certificate(self):
        bad=PublicJwks(self.url+'/jwks')
        with patch.dict(os.environ):
            os.environ.pop('SSL_CERT_FILE',None)
            bad.opener=build_opener(NoRedirect(),HTTPSHandler(context=ssl.create_default_context()))
            with self.assertRaises(Exception):bad('key1')
            with self.assertRaises(ValueError):self.member(self.tenant,self.user)
        for path,document in [('/redirect',{'keys':[self.jwk]}),('/jwks',{'keys':[{**self.jwk,'d':'private'}]}),('/jwks',{'keys':[self.jwk,self.jwk]})]:
            self.__class__.document=document
            resolver=PublicJwks(self.url+path);resolver.opener=self.keys.opener
            with self.assertRaises(Exception):resolver('key1')
    def test_bounded_jwks_and_membership_responses(self):
        self.__class__.document={'keys':[self.jwk],'padding':'x'*262144}
        with self.assertRaises(ValueError):self.keys('key1')
        self.__class__.owner_body={**self.owner_body,'padding':'x'*8192}
        with self.assertRaises(ValueError):self.member(self.tenant,self.user)

    def test_http_rejects_duplicate_headers_body_and_no_execution(self):
        def connect():raise AssertionError('must reject before database')
        server=create_server(connect=connect,verifier=lambda scope:self.verifier,authorize_alert=lambda *a:True)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            for extra,body,status in [([('Authorization',self.token)],'{}',401),([('X-Tenant-ID',self.tenant)],'{}',401),([('Content-Length','2')],'{}',400),([('Transfer-Encoding','chunked')],'{}',400),([('If-Match','"1"'),('If-Match','"1"')],'{}',400),([], '{"run_id":"a","run_id":"b"}',400)]:
                conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
                conn.putrequest('POST','/v1/advisor/proposals');conn.putheader('Authorization',self.token);conn.putheader('X-Tenant-ID',self.tenant);conn.putheader('Content-Length',str(len(body)))
                for name,value in extra:conn.putheader(name,value)
                conn.endheaders(body.encode());response=conn.getresponse();response.read();self.assertEqual(response.status,status);conn.close()
            conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3);conn.request('POST','/v1/advisor/execute',body='{}');response=conn.getresponse();response.read();self.assertEqual(response.status,404);conn.close()
        finally:server.shutdown();server.server_close();thread.join()
    def test_incomplete_headers_timeout_before_authentication(self):
        def forbidden(*args):raise AssertionError('incomplete headers reached authentication')
        server=create_server(connect=forbidden,verifier=forbidden,authorize_alert=forbidden)
        self.assertEqual(server.RequestHandlerClass.timeout,3)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with socket.create_connection(('127.0.0.1',server.server_port),timeout=5) as connection:
                connection.sendall(b'POST /v1/advisor/proposals HTTP/1.1\r\nHost: localhost\r\nX-Tenant-ID: ')
                self.assertEqual(connection.recv(1024),b'')
            # A fresh request still works after the idle header connection closes.
            conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
            conn.request('POST','/v1/advisor/execute',body='{}')
            response=conn.getresponse();self.assertEqual(response.status,404);response.read();conn.close()
        finally:server.shutdown();server.server_close();thread.join()

    def test_liveness_is_independent_but_readiness_checks_required_dependencies(self):
        def unavailable():
            raise RuntimeError('dependency probe failed')
        for readiness,ready_status in ((False,503),(True,200),(object(),503),(unavailable,503)):
            healthcheck = readiness if callable(readiness) else lambda:readiness
            server=create_server(connect=lambda:None,verifier=lambda scope:self.verifier,
                                 authorize_alert=lambda *a:True,healthcheck=healthcheck)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                for path,status in [('/healthz',200),('/readyz',ready_status)]:
                    conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
                    conn.request('GET',path);response=conn.getresponse()
                    self.assertEqual(response.status,status);response.read();conn.close()
            finally:server.shutdown();server.server_close();thread.join()

    def test_membership_revoked_after_body_before_mutation(self):
        original=self.verifier.verify
        calls=[]
        def verify(*args):
            principal=original(*args);calls.append(principal)
            self.owner_body['roles']=['viewer']
            return principal
        self.verifier.verify=verify
        def connect():raise AssertionError('revoked request reached database')
        server=create_server(connect=connect,verifier=lambda scope:self.verifier,authorize_alert=lambda *a:True)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
            conn.request('POST','/v1/advisor/proposals',body='{}',headers={'Authorization':self.token,'X-Tenant-ID':self.tenant})
            response=conn.getresponse();self.assertEqual(response.status,403);response.read();conn.close()
            self.assertEqual(len(calls),1)
        finally:server.shutdown();server.server_close();thread.join()

    def test_factory_requires_owner_adapter_and_configures_both_scopes(self):
        from advisor_security.receiver import configured_server
        args=dict(issuer='https://issuer.test',jwks_url=self.url+'/jwks',membership_url=self.url,membership_service_token='service',database_url='postgresql://advisor/db',port=0)
        with self.assertRaises(ValueError):configured_server(**args,authorize_alert=None)
        fake_server=type('FakeServer',(),{})()
        with patch('advisor_security.receiver.create_server',return_value=fake_server) as create:
            self.assertIs(configured_server(**args,authorize_alert=lambda *a:True),fake_server)
            factory=create.call_args.kwargs['verifier']
            self.assertEqual(factory('advisor:decide').scope,'advisor:decide')
            self.assertIs(factory('advisor:decide').membership,factory('advisor:propose').membership)

    def test_owner_and_final_membership_denial_precede_database_acquisition(self):
        connections=[]
        def connect():connections.append(True);raise AssertionError('database acquired before authorization')
        for mode in ('deny','revoke'):
            self.__class__.owner_status=200;self.owner_body['roles']=['operator']
            def owner(*args):
                if mode=='revoke':self.__class__.owner_status=404;return True
                return False
            server=create_server(connect=connect,verifier=lambda scope:self.verifier,authorize_alert=owner)
            threading.Thread(target=server.serve_forever,daemon=True).start()
            try:
                connection=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
                body=json.dumps({'run_id':str(uuid4()),'alert_id':str(uuid4()),'note':'review','etag':'"1"'})
                connection.request('POST','/v1/advisor/proposals',body=body,headers={'Authorization':self.token,'X-Tenant-ID':self.tenant})
                response=connection.getresponse();self.assertIn(response.status,(403,404));response.read();connection.close()
                self.assertEqual(connections,[])
            finally:server.shutdown();server.server_close()
