"""Ephemeral runsc pod, PDF bytes through exec stdin; no object URLs or identities."""
import json
import re
import subprocess
from uuid import uuid4
from .parser_sandbox import bind_passages, run_bounded
from .pdf_parser import MAX_PDF_BYTES, PdfParseError

class KubernetesPdfParser:
    def __init__(self, *, image: str, namespace: str='greenguard-parser', timeout: int=60, ocr: bool=False):
        if not re.fullmatch(r'[a-z0-9][a-zA-Z0-9._:/-]*@sha256:[0-9a-f]{64}',image):
            raise ValueError('digest-pinned parser image required')
        if namespace!='greenguard-parser' or type(timeout) is not int or not 1<=timeout<=120:
            raise ValueError('dedicated parser namespace and bounded timeout required')
        if type(ocr) is not bool:
            raise ValueError("OCR flag must be boolean")
        self.ocr=ocr
        self.image=image
        self.namespace=namespace
        self.timeout=timeout

    def pod(self,name: str) -> dict:
        return {'apiVersion':'v1','kind':'Pod',
            'metadata':{'name':name,'namespace':self.namespace,'labels':{'app':'knowledge-parser'}},
            'spec':{'runtimeClassName':'greenguard-parser-runsc','serviceAccountName':'knowledge-parser',
                'automountServiceAccountToken':False,'restartPolicy':'Never',
                'activeDeadlineSeconds':self.timeout+90,'terminationGracePeriodSeconds':1,
                'securityContext':{'runAsNonRoot':True,'runAsUser':10001,'runAsGroup':10001,
                    'seccompProfile':{'type':'RuntimeDefault'}},
                'containers':[{'name':'parser','image':self.image,'imagePullPolicy':'IfNotPresent',
                    'command':['python','-c','import time; time.sleep(210)'],
                    **({'env':[{'name':'KNOWLEDGE_PARSER_OCR','value':'true'}]} if self.ocr else {}),
                    'securityContext':{'allowPrivilegeEscalation':False,'readOnlyRootFilesystem':True,
                        'capabilities':{'drop':['ALL']}},
                    'resources':{'requests':{'cpu':'250m','memory':'256Mi'},
                        'limits':{'cpu':'1','memory':'512Mi','ephemeral-storage':'64Mi'}},
                    'volumeMounts':[{'name':'scratch','mountPath':'/tmp'}]}],
                'volumes':[{'name':'scratch','emptyDir':{'medium':'Memory','sizeLimit':'32Mi'}}]}}

    def parse(self,data: bytes, *, tenant_id: str, document_id: str, document_version: int):
        if not data.startswith(b'%PDF-') or not 8<=len(data)<=MAX_PDF_BYTES:
            raise PdfParseError('input is not a bounded PDF')
        name='gg-parser-'+uuid4().hex
        base=['kubectl','--namespace',self.namespace,'--request-timeout=15s']
        try:
            subprocess.run(base+['create','-f','-'],input=json.dumps(self.pod(name)).encode(),
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20,check=True)
            subprocess.run(base+['wait','--for=condition=Ready','pod/'+name,'--timeout=60s'],
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=65,check=True)
            # Avoid request-timeout on the streaming exec; local deadline bounds the session.
            payload=run_bounded(['kubectl','--namespace',self.namespace,'exec','-i',name,
                '-c','parser','--','python','parser_worker.py'],data,self.timeout)
            return bind_passages(payload,data=data,tenant_id=tenant_id,document_id=document_id,
                                 document_version=document_version)
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired) as exc:
            # Scheduling/API failures are retryable; do not mark the PDF permanently invalid.
            raise RuntimeError('Kubernetes parser launch or session failed') from exc
        finally:
            try:
                subprocess.run(base+['delete','pod',name,'--ignore-not-found','--wait=false'],
                    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20,check=True)
            except (OSError,subprocess.SubprocessError):
                # activeDeadline bounds orphan execution; janitor removes terminated pods.
                pass
