"""Configured HTTPS public JWKS only; bounded requests/cache and no redirects."""
import json
import re
import threading
import time
from urllib.parse import urlsplit
from .owner_http import bounded_request, NoRedirect
import jwt

class PublicJwks:
    def __init__(self,url,cache_seconds=60):
        parsed=urlsplit(url)
        if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or not 1<=cache_seconds<=300:raise ValueError('configured HTTPS JWKS required')
        self.url=url;self.cache_seconds=cache_seconds;self.keys={};self.expires=0.;self.lock=threading.Lock();self.next_fetch=0.
    def __call__(self,kid):
        snapshot=getattr(self,'snapshot',None)
        if snapshot is not None and time.monotonic()<snapshot[0] and kid in snapshot[1]:return snapshot[1][kid]
        with self.lock:
            now=time.monotonic()
            if now<self.expires and kid in self.keys:return self.keys[kid]
            if now<self.next_fetch:
                if now<self.expires:return None
                raise ValueError('JWKS refresh unavailable')
            self.next_fetch=now+1
            status,raw=bounded_request(self.url,'',method='GET',headers={'Accept':'application/json'},max_bytes=262144,
                                       operation='Advisor.identity.jwks',propagate_trace=False)
            if status!=200:raise ValueError('JWKS endpoint unavailable')
            if len(raw)>262144:raise ValueError('JWKS exceeds bound')
            document=json.loads(raw)
            if not isinstance(document,dict) or not isinstance(document.get('keys'),list) or not 1<=len(document['keys'])<=32:raise ValueError('invalid JWKS')
            keys={}
            for value in document['keys']:
                if not isinstance(value,dict):raise ValueError('invalid JWK')
                if value.get('kty')!='RSA' or value.get('alg')!='RS256' or value.get('use','sig')!='sig':continue
                name=value.get('kid')
                if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,128}',name) or name in keys:raise ValueError('invalid key ID')
                if any(k in value for k in ('d','p','q','dp','dq','qi','oth')) or value.get('key_ops',['verify'])!=['verify']:raise ValueError('private or unusable JWKS')
                key=jwt.PyJWK.from_dict(value,algorithm='RS256').key
                if not 2048<=key.key_size<=8192:raise ValueError('unsupported RSA key')
                keys[name]=key
            if not keys:raise ValueError('no verification keys')
            self.keys=keys;self.expires=time.monotonic()+self.cache_seconds;self.snapshot=(self.expires,keys)
            return keys.get(kid)
