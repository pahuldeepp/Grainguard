"""Disposable pinned local Dex fixture; credentials remain in the caller process."""
from contextlib import contextmanager
import os
from pathlib import Path
import socket
import subprocess
from tempfile import TemporaryDirectory
import time
from urllib.request import urlopen
from uuid import uuid4
import json
ROOT=Path(__file__).resolve().parents[2]
IMAGE='ghcr.io/dexidp/dex:v2.43.1@sha256:0881d3c9359b436d585b2061736ce271c100331e073be9178ef405ce5bf09557'

@contextmanager
def local_dex():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
    issuer=f'http://127.0.0.1:{port}/dex'
    name='greenguard-dex-rag-'+uuid4().hex[:10]
    password=uuid4().hex
    with TemporaryDirectory(prefix='greenguard-dex-') as directory:
        config=Path(directory)/'dex.yaml.tpl'
        config.write_text((ROOT/'infra/oidc/dex.yaml.tpl').read_text().replace(
            'issuer: http://127.0.0.1:5556/dex',f'issuer: {issuer}'))
        env=dict(os.environ,OIDC_DEV_PASSWORD=password,OIDC_TOKEN_TTL='5m')
        subprocess.run(['docker','run','--rm','-d','--name',name,
                        '-e','OIDC_DEV_PASSWORD','-e','OIDC_TOKEN_TTL',
                        '-p',f'127.0.0.1:{port}:5556','-v',f'{config}:/etc/dex/dex.yaml.tpl:ro',
                        IMAGE,'dex','serve','/etc/dex/dex.yaml.tpl'],env=env,
                       check=True,capture_output=True,text=True)
        try:
            for attempt in range(60):
                try:
                    with urlopen(issuer+'/.well-known/openid-configuration',timeout=2) as response:
                        discovery=json.load(response)
                    assert discovery['issuer']==issuer
                    assert discovery['jwks_uri']==issuer+'/keys'
                    break
                except OSError:
                    if attempt==59:raise RuntimeError('Dex readiness timed out') from None
                    time.sleep(.5)
            yield {"issuer":issuer,"password":password,"discovery":discovery}
        finally:
            subprocess.run(["docker","rm","-f",name],capture_output=True,check=False)
