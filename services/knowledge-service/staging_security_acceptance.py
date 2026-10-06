"""Future live runtime smoke. Creates a temporary pod only with --execute."""
import argparse
import json
import subprocess
from uuid import uuid4
from knowledge_extensions.parser_kubernetes import KubernetesPdfParser
from knowledge_extensions.file_validation import ClamAvScanner
from tests.pdf_fixture import make_text_pdf

p=argparse.ArgumentParser()
p.add_argument('--execute',action='store_true')
p.add_argument('--parser-image',required=True)
p.add_argument('--clamav-host',required=True)
a=p.parse_args()
if not a.execute:
    p.error('Live cluster mutation requires --execute; do not run before deployment authorization')
parser=KubernetesPdfParser(image=a.parser_image)
name='gg-parser-acceptance-'+uuid4().hex
base=['kubectl','-n',parser.namespace,'--request-timeout=15s']
try:
    subprocess.run(base+['create','-f','-'],input=json.dumps(parser.pod(name)).encode(),check=True,timeout=20)
    subprocess.run(base+['wait','--for=condition=Ready','pod/'+name,'--timeout=60s'],check=True,timeout=65)
    probe=r'''import os,socket,errno
assert not os.path.exists('/var/run/secrets/kubernetes.io/serviceaccount/token')
assert 'gvisor' in open('/proc/version').read().lower()
try:
    socket.create_connection(('1.1.1.1',443),timeout=2)
except OSError:
    pass
else:
    raise AssertionError('parser egress allowed')
try:
    open('/home/parser/unexpected-write','w').close()
except OSError as error:
    if error.errno != errno.EROFS:
        raise
else:
    raise AssertionError('root filesystem writable')
print('runtime/no-token/no-egress/read-only: passed')'''
    subprocess.run(base+['exec',name,'--','python','-c',probe],check=True,timeout=20)
finally:
    subprocess.run(base+['delete','pod',name,'--ignore-not-found','--wait=false'],check=True,timeout=20)
pdf=make_text_pdf([['Wheat storage', 'Keep grain dry.']])
scanner=ClamAvScanner(host=a.clamav_host)
scanner.scan(pdf)
result=parser.parse(pdf,tenant_id='11111111-1111-4111-8111-111111111111',
                    document_id='22222222-2222-4222-8222-222222222222',document_version=1)
assert result.chunks
print('clean PDF scan -> gVisor -> trusted canonical chunks: passed')
print('Still required: EICAR rejection, stale-signature withdrawal, RBAC denial, crash cleanup, staging RAG E2E')
