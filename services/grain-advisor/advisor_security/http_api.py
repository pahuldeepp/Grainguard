"""Bounded Advisor propose, approval, and owner-authorized execution adapter."""
import json
import re
import threading
import time
from urllib.parse import urlsplit, parse_qs
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from .delegated import DelegationError
from .policy import PolicyDenied,uuid,authorize_tool
from .proposals import propose,decide,execute_approved,list_pending,Conflict,NotFound
from .execution import ExecutionError
from .tracing import default_tracing, finish_span
from opentelemetry import trace
from opentelemetry.trace import SpanKind


def closed_object(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise PolicyDenied('duplicate_json_key')
        result[key]=value
    return result


def create_server(*,connect,verifier,authorize_alert,execute_action=None,
                  workflow_start=None,workflow_resume=None,healthcheck=None,
                  host='127.0.0.1',port=0,tracing=None):
    # Callers provide configured JWT/JWKS verifier and current owning-API target
    # authorization. There is no fallback static token or trusted header identity.
    tracing = tracing or default_tracing()
    class Handler(BaseHTTPRequestHandler):
        # StreamRequestHandler applies this before request-line/header reads.
        timeout=3
        def log_message(self,*args):pass
        def reply(self,status,body):
            self._trace_status=status
            finish_span(trace.get_current_span(), status=status)
            raw=json.dumps(body,separators=(',',':')).encode()
            self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        def do_GET(self):
            path=urlsplit(self.path).path
            operation = ('Advisor.http.get_health' if path=='/healthz' else
                         'Advisor.http.get_readiness' if path=='/readyz' else
                         'Advisor.http.get_proposals' if path=='/v1/advisor/proposals' else
                         'Advisor.http.get_other')
            self._traced(operation, self._do_GET)
        def _do_GET(self):
            try:
                parsed=urlsplit(self.path)
                if parsed.path == '/healthz' and not parsed.query:
                    self.reply(200,{'status':'ok'})
                    return
                if parsed.path == '/readyz' and not parsed.query:
                    if healthcheck is not None:
                        healthy=healthcheck()
                    else:
                        with connect() as db: db.execute('SELECT 1')
                        healthy=True
                    ready=healthy is True
                    self.reply(200 if ready else 503,{'status':'ok' if ready else 'unavailable'})
                    return
                if parsed.path!='/v1/advisor/proposals':self.reply(404,{'error':'not_found'});return
                if len(self.headers.get_all('Authorization',[]))!=1 or len(self.headers.get_all('X-Tenant-ID',[]))!=1:raise DelegationError(401,'invalid_headers')
                principal=verifier('advisor:decide').verify(self.headers.get('Authorization'),self.headers.get('X-Tenant-ID'))
                values=parse_qs(parsed.query,keep_blank_values=True)
                if set(values)-{'limit'} or any(len(v)!=1 for v in values.values()):raise PolicyDenied('invalid_limit')
                limit=int(values.get('limit',['50'])[0])
                with connect() as db:result=list_pending(db,principal,limit)
                self.reply(200,{'items':result})
            except DelegationError as exc:self.reply(exc.status,{'error':str(exc)})
            except (PolicyDenied,ValueError,TypeError):self.reply(400,{'error':'invalid_request'})
            except Exception:self.reply(503,{'error':'advisor_unavailable'})
        def do_POST(self):
            match=re.fullmatch(r'/v1/advisor/proposals/([0-9a-f-]{36})/(decision|execution)',self.path)
            operation = ('Advisor.http.post_decision' if match and match[2]=='decision' else
                         'Advisor.http.post_execution' if match and match[2]=='execution' else
                         'Advisor.http.post_proposal' if self.path=='/v1/advisor/proposals' else
                         'Advisor.http.post_other')
            self._traced(operation, self._do_POST)
        def _do_POST(self):
            try:
                match=re.fullmatch(r'/v1/advisor/proposals/([0-9a-f-]{36})/(decision|execution)',self.path)
                if self.path!='/v1/advisor/proposals' and not match:self.reply(404,{'error':'not_found'});return
                decision=bool(match and match[2]=='decision')
                execution=bool(match and match[2]=='execution')
                scope='advisor:decide' if match else 'advisor:propose'
                auth=self.headers.get('Authorization','');tenant=self.headers.get('X-Tenant-ID')
                if len(self.headers.get_all('Authorization',[]))!=1 or len(self.headers.get_all('X-Tenant-ID',[]))!=1:raise DelegationError(401,'invalid_headers')
                principal=verifier(scope).verify(auth,tenant)
                if (len(self.headers.get_all('Content-Length',[]))!=1 or self.headers.get_all('Transfer-Encoding',[])
                        or any(len(self.headers.get_all(name,[]))>1 for name in ('If-Match','Idempotency-Key','X-Owner-Delegated-Token'))):raise PolicyDenied('ambiguous_request')
                length=int(self.headers.get('Content-Length','-1'))
                if not 0<length<=8192:raise PolicyDenied('invalid_body_size')
                deadline=time.monotonic()+3;raw=bytearray()
                while len(raw)<length:
                    remaining=deadline-time.monotonic()
                    if remaining<=0:raise PolicyDenied('body_timeout')
                    self.connection.settimeout(remaining)
                    block=self.rfile.read1(min(8192,length-len(raw)))
                    if not block:raise PolicyDenied('incomplete_body')
                    raw.extend(block)
                body=json.loads(raw,object_pairs_hook=closed_object)
                if not isinstance(body,dict):raise PolicyDenied('invalid_body')
                # Refresh current membership/expiry immediately before mutation.
                principal=verifier(scope).verify(auth,tenant)
                if decision:
                    if set(body)!={'decision','action_hash','version'} or self.headers.get('If-Match')!='"'+str(body['version'])+'"':raise PolicyDenied('invalid_decision')
                    owner_token=self.headers.get('X-Owner-Delegated-Token') if body['decision']=='approved' else None
                    if workflow_resume is not None:
                        request_id=self.headers.get('Idempotency-Key','')
                        if not uuid(request_id):raise PolicyDenied('invalid_idempotency_key')
                        try:
                            result=workflow_resume(principal,match[1],{
                                'decision':body['decision'],'action_hash':body['action_hash'],
                                'version':body['version'],'request_id':request_id,
                            },owner_token)
                        except NotFound as exc:
                            if str(exc)!='workflow_checkpoint_missing':raise
                            # Existing proposals may predate workflow enablement
                            # or survive a checkpoint outage after DB commit.
                            with connect() as db:
                                result=decide(db,principal,match[1],decision=body['decision'],
                                    action_hash=body['action_hash'],version=body['version'],
                                    request_id=request_id,execute_action=execute_action,
                                    owner_token=owner_token)
                        if isinstance(result,dict) and isinstance(result.get('decision_result'),dict):
                            result=result['decision_result']
                    else:
                        with connect() as db:
                            result=decide(db,principal,match[1],decision=body['decision'],action_hash=body['action_hash'],version=body['version'],request_id=self.headers.get('Idempotency-Key',''),execute_action=execute_action,owner_token=owner_token)
                elif execution:
                    if set(body)!={'action_hash','version'} or self.headers.get('If-Match')!='"'+str(body['version'])+'"':raise PolicyDenied('invalid_execution')
                    owner_token=self.headers.get('X-Owner-Delegated-Token')
                    with connect() as db:
                        result=execute_approved(db,principal,match[1],action_hash=body['action_hash'],version=body['version'],execute_action=execute_action,owner_token=owner_token)
                else:
                    if set(body)!={'run_id','alert_id','note','etag'} or not uuid(body['run_id']):raise PolicyDenied('invalid_proposal')
                    args={k:body[k] for k in ('alert_id','note','etag')}
                    authorize_tool(principal,'propose_acknowledge_alert',args)
                    if authorize_alert(principal,body['alert_id'],body['etag']) is not True:raise NotFound('target_not_found')
                    principal=verifier(scope).verify(auth,tenant)
                    # Owner HTTP and membership refresh must finish before acquiring DB.
                    with connect() as db:result=propose(db,principal,body['run_id'],args)
                    if workflow_start is not None:
                        workflow_start(principal,body['run_id'],result)
                self.reply(200 if match else 201,result)
            except DelegationError as exc:self.reply(exc.status,{'error':str(exc)})
            except NotFound:self.reply(404,{'error':'not_found'})
            except Conflict as exc:self.reply(409,{'error':str(exc)})
            except ExecutionError as exc:self.reply(503 if exc.retryable else 409,{'error':exc.code})
            except (PolicyDenied,ValueError,TypeError,KeyError):self.reply(400,{'error':'invalid_request'})
            except Exception:self.reply(503,{'error':'advisor_unavailable'})
        def _traced(self,operation,handler):
            self._trace_status=None
            parent=tracing.extract(self.headers.get('traceparent'))
            with tracing.span(operation,parent=parent,kind=SpanKind.SERVER) as span:
                try:
                    handler()
                except BaseException:
                    finish_span(span,outcome='error')
                    raise
                finally:
                    if self._trace_status is None:
                        finish_span(span,outcome='error')
    class Server(ThreadingHTTPServer):
        # Let server_close() drain active handlers during graceful shutdown.
        daemon_threads=False
        def __init__(self,*args):self.slots=threading.BoundedSemaphore(8);super().__init__(*args)
        def process_request(self,request,address):
            if not self.slots.acquire(blocking=False):
                self.shutdown_request(request);return
            try:super().process_request(request,address)
            except Exception:self.slots.release();raise
        def process_request_thread(self,request,address):
            try:super().process_request_thread(request,address)
            finally:self.slots.release()
    return Server((host,port),Handler)
