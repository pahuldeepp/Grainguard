import json,threading,unittest
from datetime import datetime,timedelta,timezone
from uuid import uuid4
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlsplit,parse_qs
from advisor_security.alerts import AlertsOwnership,configured_owner
from advisor_security.membership import ControlPlaneMemberships
from advisor_security.policy import Principal
from advisor_security.delegated import DelegationError

class AlertsTests(unittest.TestCase):
    def test_config_fail_closed(self):
        with self.assertRaises(DelegationError):configured_owner()(None,None,None)
        for origin,token in [('http://external.test','a'*32),('https://user:pass@example.test','a'*32),('https://example.test/path','a'*32),('https://example.test','short')]:
            with self.assertRaises(ValueError):AlertsOwnership(origin,token)
    def test_strict_bounded_owner_receipt_denials_and_service_auth(self):
        principal=Principal(str(uuid4()),str(uuid4()),'operator','grain-advisor',datetime.now(timezone.utc)+timedelta(minutes=1));alert=str(uuid4());token='a'*32
        state={'status':200,'mode':'valid'};requests=[]
        class Owner(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                requests.append(self.headers['Authorization']);selectors={key:value[0] for key,value in parse_qs(urlsplit(self.path).query).items()}
                body={'authorized':True,**selectors}
                if state['mode']=='extra':body['private']='secret'
                if state['mode']=='mismatch':body['tenantId']=str(uuid4())
                raw=json.dumps(body).encode() if state['mode']!='oversize' else b'x'*8193
                self.send_response(state['status'])
                if state['status']==302:self.send_header('Location','/elsewhere')
                self.end_headers();self.wfile.write(raw)
        server=ThreadingHTTPServer(('127.0.0.1',0),Owner);threading.Thread(target=server.serve_forever,daemon=True).start()
        adapter=AlertsOwnership(f'http://127.0.0.1:{server.server_port}',token)
        try:
            self.assertIs(adapter(principal,alert,'"1"'),True);self.assertEqual(requests,['Bearer '+token])
            for code in [403,404]:state['status']=code;self.assertIs(adapter(principal,alert,'"1"'),False)
            for code in [401,503,302]:
                state['status']=code
                with self.assertRaises(DelegationError):adapter(principal,alert,'"1"')
            state['status']=200
            for mode in ['extra','mismatch','oversize']:
                state['mode']=mode
                with self.assertRaises(DelegationError):adapter(principal,alert,'"1"')
        finally:server.shutdown();server.server_close()
        with self.assertRaises(DelegationError):adapter(principal,alert,'"1"')
    def test_total_deadline_cuts_header_and_body_drips_and_reaps_worker(self):
        import time,subprocess
        from unittest.mock import patch
        principal=Principal(str(uuid4()),str(uuid4()),'operator','grain-advisor',datetime.now(timezone.utc)+timedelta(minutes=1));alert=str(uuid4());mode=['headers'];workers=[]
        class Drip(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                selectors={key:value[0] for key,value in parse_qs(urlsplit(self.path).query).items()}
                body=json.dumps({'tenantId':selectors['tenantId'],'identityId':selectors['identityId'],'state':'active','roles':['operator']} if 'identityId' in selectors else {'authorized':True,**selectors}).encode()
                try:
                    if mode[0]=='headers':
                        self.connection.sendall(b'HTTP/1.1 200 OK\r\nX-Drip: ')
                        for _ in range(40):self.connection.sendall(b'a');time.sleep(.1)
                        return
                    self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers()
                    if mode[0]=='body':
                        for byte in body:self.wfile.write(bytes([byte]));self.wfile.flush();time.sleep(.1)
                    else:self.wfile.write(body)
                except (BrokenPipeError,ConnectionResetError):pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Drip);threading.Thread(target=server.serve_forever,daemon=True).start()
        adapter=AlertsOwnership(f'http://127.0.0.1:{server.server_port}','a'*32)
        original=subprocess.Popen
        def spawn(*args,**kwargs):
            worker=original(*args,**kwargs);workers.append(worker);return worker
        try:
            with patch('advisor_security.owner_http.subprocess.Popen',side_effect=spawn):
                for slow in ['headers','body']:
                    mode[0]=slow;started=time.monotonic()
                    with self.assertRaises(DelegationError):adapter(principal,alert,'"1"')
                    elapsed=time.monotonic()-started
                    self.assertGreater(elapsed,1.8);self.assertLess(elapsed,2.7)
                    self.assertIsNotNone(workers[-1].poll())
                    self.assertTrue(workers[-1].stdin.closed and workers[-1].stdout.closed)
                    mode[0]='valid';self.assertIs(adapter(principal,alert,'"1"'),True)
                membership=ControlPlaneMemberships(f'http://127.0.0.1:{server.server_port}','a'*32)
                for slow in ['headers','body']:
                    mode[0]=slow;started=time.monotonic()
                    with self.assertRaises(Exception):membership(principal.tenant_id,principal.user_id)
                    self.assertLess(time.monotonic()-started,2.7)
                    self.assertIsNotNone(workers[-1].poll())
                    self.assertTrue(workers[-1].stdin.closed and workers[-1].stdout.closed)
                    mode[0]='valid';self.assertEqual(membership(principal.tenant_id,principal.user_id),['operator'])
                self.assertTrue(all(worker.poll() is not None for worker in workers))
        finally:server.shutdown();server.server_close()
