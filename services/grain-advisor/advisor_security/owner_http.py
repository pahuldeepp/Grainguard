"""Isolated stdlib HTTP worker; parent enforces total deadline and reaps it."""
import base64
import json
import sys
import subprocess
import time
from pathlib import Path
from urllib.request import Request,build_opener,HTTPRedirectHandler
from urllib.error import HTTPError
if __package__:
    from opentelemetry.trace import SpanKind
    from .tracing import default_tracing, finish_span

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

_OWNER_OPERATIONS={
    'Advisor.owner.membership', 'Advisor.owner.alert_authorization',
    'Advisor.owner.alert_acknowledgement', 'Advisor.owner.readiness',
    'Advisor.identity.jwks',
}

def bounded_request(url,token,method='GET',headers=None,body=b'',max_bytes=8192,
                    operation='Advisor.owner.readiness',propagate_trace=True):
    if operation not in _OWNER_OPERATIONS:
        raise ValueError('unregistered Advisor owner operation')
    tracer=default_tracing()
    with tracer.span(operation,kind=SpanKind.CLIENT) as span:
        try:
            outgoing=dict(headers or {})
            if propagate_trace:
                carrier={}
                tracer.inject(carrier)
                if 'traceparent' in carrier:
                    outgoing['traceparent']=carrier['traceparent']
            status,body_bytes=_bounded_request(url,token,method,outgoing,body,max_bytes)
            finish_span(span,status=status)
            return status,body_bytes
        except BaseException:
            finish_span(span,outcome='error')
            raise

def _bounded_request(url,token,method='GET',headers=None,body=b'',max_bytes=8192):
    # A reaped process bounds DNS, TLS and header/body drips without blocked threads.
    if type(max_bytes) is not int or not 1<=max_bytes<=262144:
        raise ValueError('invalid response bound')
    deadline=time.monotonic()+2
    worker=subprocess.Popen([sys.executable,str(Path(__file__).resolve())],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    try:
        output,_=worker.communicate(json.dumps({'url':url,'token':token,'method':method,'headers':headers or {},'body':base64.b64encode(body).decode(),'max_bytes':max_bytes}).encode(),timeout=max(.001,deadline-time.monotonic()))
    except BaseException:
        worker.kill();worker.communicate();raise
    finally:worker.wait()
    if time.monotonic()>deadline or worker.returncode!=0:raise ValueError('owner deadline exceeded')
    result=json.loads(output)
    raw=base64.b64decode(result['body'],validate=True)
    if len(raw)>max_bytes:raise ValueError('owner response exceeds bounds')
    return result['status'],raw

def bounded_get(url,token,*,operation='Advisor.owner.readiness',propagate_trace=True):
    return bounded_request(url,token,operation=operation,propagate_trace=propagate_trace)

def main():
    raw=sys.stdin.buffer.read(65537)
    if len(raw)>65536:raise SystemExit(2)
    request=json.loads(raw)
    try:
        headers={'Accept':'application/json',**request.get('headers',{})}
        if request.get('token'):
            headers['Authorization']='Bearer '+request['token']
        body=base64.b64decode(request.get('body',''),validate=True) if request.get('body') else None
        max_bytes=request.get('max_bytes',8192)
        if type(max_bytes) is not int or not 1<=max_bytes<=262144:raise ValueError('invalid response bound')
        with build_opener(NoRedirect()).open(Request(request['url'],method=request.get('method','GET'),data=body,headers=headers),timeout=2) as response:
            result={'status':response.status,'body':base64.b64encode(response.read(max_bytes+1)).decode()}
    except HTTPError as error:
        result={'status':error.code,'body':''};error.close()
    except Exception:
        result={'status':503,'body':''}
    sys.stdout.write(json.dumps(result))

if __name__=='__main__':main()
