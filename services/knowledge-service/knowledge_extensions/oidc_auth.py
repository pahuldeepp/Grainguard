"""RS256 identity verification and authoritative tenant-scoped membership lookup."""
from __future__ import annotations
import json
import hashlib
import math
import os
import re
import threading
import time
from collections import OrderedDict
from urllib.parse import urlsplit, urlencode
from urllib.error import HTTPError
from urllib.request import Request, build_opener
from .http_transport import NoRedirect
from uuid import UUID
import jwt
from .http_api import ApiError, ApiPrincipal

def canonical_uuid(value):
    try:
        return isinstance(value,str) and str(UUID(value))==value
    except (ValueError,AttributeError):
        return False

def identity_id_of(issuer: str, subject: str) -> str:
    """Match tenant-control-plane's stable nameId("identity", issuer, subject)."""
    raw = bytearray(hashlib.sha256(f"identity\n{issuer}\n{subject}".encode()).digest()[:16])
    raw[6] = (raw[6] & 0x0f) | 0x50
    raw[8] = (raw[8] & 0x3f) | 0x80
    value = UUID(bytes=bytes(raw))
    return str(value)

def configured_oidc_url(url: str, *, allow_local_http: bool=False) -> bool:
    parsed=urlsplit(url)
    local_http=(allow_local_http and os.environ.get('KNOWLEDGE_ENVIRONMENT')=='local-synthetic'
                and parsed.scheme=='http' and parsed.hostname in {'127.0.0.1','localhost','::1'})
    return bool((parsed.scheme=='https' or local_http) and parsed.hostname
                and not parsed.username and not parsed.password and not parsed.fragment
                and not parsed.query and len(url)<=2048)

class PostgresMemberships:
    """Explicit local-synthetic fallback; never use unsynchronized rows in production."""
    uses_database_membership = True
    def __init__(self,connect):
        self.connect=connect

    def resolve(self, *, issuer: str, subject: str, tenant_id: str) -> ApiPrincipal:
        if not canonical_uuid(tenant_id):
            raise ApiError(400,'invalid_tenant_selector')
        try:
            with self.connect() as connection:
                with connection.transaction():
                    connection.execute("SELECT set_config('app.tenant_id', %s, true)",(tenant_id,))
                    row=connection.execute(
                        """SELECT principal_id::text,roles FROM knowledge_auth_memberships
                           WHERE tenant_id=%s AND issuer=%s AND subject=%s AND active=true""",
                        (tenant_id,issuer,subject),
                    ).fetchone()
        except Exception as exc:
            raise ApiError(503,'auth_unavailable') from exc
        if row is None:
            raise ApiError(403,'membership_required')
        principal_id,roles=row
        if not canonical_uuid(principal_id) or not roles or any(r not in {'viewer','operator','admin'} for r in roles):
            raise ApiError(503,'auth_unavailable')
        role=max(roles,key={'viewer':1,'operator':2,'admin':3}.__getitem__)
        return ApiPrincipal(tenant_id,principal_id,role)

    def resolve_principal(self, *, principal_id: str, tenant_id: str) -> ApiPrincipal:
        """Internal workers resolve their persisted canonical owner, not JWT aliases."""
        if not canonical_uuid(tenant_id) or not canonical_uuid(principal_id):
            raise ApiError(400, 'invalid_tenant_selector')
        try:
            with self.connect() as connection, connection.transaction():
                connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                row = connection.execute(
                    "SELECT roles FROM knowledge_auth_memberships WHERE tenant_id=%s AND principal_id=%s AND active=true",
                    (tenant_id, principal_id),
                ).fetchone()
        except Exception as exc:
            raise ApiError(503, 'auth_unavailable') from exc
        if row is None:
            raise ApiError(403, 'membership_required')
        roles = row[0]
        if not roles or any(role not in {'viewer','operator','admin'} for role in roles):
            raise ApiError(503, 'auth_unavailable')
        return ApiPrincipal(tenant_id, principal_id, max(roles, key={'viewer':1,'operator':2,'admin':3}.__getitem__))

    def resolve_delegated(self, *, subject: str, tenant_id: str) -> ApiPrincipal:
        """Resolve a downstream token by stable GreenGuard identity, never by caller tenant claims."""
        if not canonical_uuid(tenant_id) or not canonical_uuid(subject):
            raise ApiError(400, 'invalid_tenant_selector')
        try:
            with self.connect() as connection:
                with connection.transaction():
                    connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                    row = connection.execute(
                        """SELECT principal_id::text,roles FROM knowledge_auth_memberships
                           WHERE tenant_id=%s AND COALESCE(delegated_identity_id,principal_id)=%s AND active=true""",
                        (tenant_id, subject),
                    ).fetchone()
        except Exception as exc:
            raise ApiError(503, 'auth_unavailable') from exc
        if row is None:
            raise ApiError(403, 'membership_required')
        principal_id, roles = row
        if not canonical_uuid(principal_id) or not roles or any(r not in {'viewer','operator','admin'} for r in roles):
            raise ApiError(503, 'auth_unavailable')
        return ApiPrincipal(tenant_id, principal_id, max(roles, key={'viewer':1,'operator':2,'admin':3}.__getitem__))


_ROLE_LEVEL = {'viewer': 1, 'operator': 2, 'admin': 3}
_INT64_MAX = 9223372036854775807

def _membership_shape(body, *, delegated=False):
    if not isinstance(body, dict):
        raise ValueError('malformed membership response')
    expected_fields = {'tenantId','roles','version','state'} | ({'identityId'} if delegated else set())
    if set(body) != expected_fields:
        raise ValueError('malformed membership response')
    tenant_id = body.get('tenantId')
    roles = body.get('roles')
    state = body.get('state')
    version = body.get('version')
    identity_id = body.get('identityId') if delegated else None
    if (not canonical_uuid(tenant_id) or state not in {'active','revoked'}
            or not isinstance(version, str) or not re.fullmatch(r'[1-9][0-9]{0,18}', version)
            or int(version) > _INT64_MAX or not isinstance(roles, list)
            or any(type(role) is not str or role not in _ROLE_LEVEL for role in roles)
            or len(set(roles)) != len(roles)
            or (state == 'active' and not roles) or (state == 'revoked' and roles)):
        raise ValueError('malformed membership response')
    if delegated and not canonical_uuid(identity_id):
        raise ValueError('malformed delegated membership response')
    return tenant_id, roles, state, identity_id


class ControlPlaneMemberships:
    """Resolve end-user and delegated membership from the authoritative owner per operation."""
    uses_database_membership = False

    def __init__(self, *, base_url: str, token: str, allow_mesh_http: bool = False,
                 timeout_seconds: float = 2.0, opener=None):
        parsed = urlsplit(base_url)
        secure_https = parsed.scheme == 'https'
        mesh_http = (allow_mesh_http and parsed.scheme == 'http'
                     and parsed.hostname == 'tenant-control-plane.greenguard.svc.cluster.local'
                     and parsed.port == 3010)
        if (not (secure_https or mesh_http) or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or len(base_url) > 2048):
            raise ValueError('Control Plane URL must use HTTPS or the explicitly enabled internal mesh endpoint')
        if not isinstance(token, str) or len(token.encode()) < 32 or len(token) > 4096:
            raise ValueError('CONTROL_LOOKUP_TOKEN must contain at least 32 bytes')
        if not 0.1 <= timeout_seconds <= 2.0:
            raise ValueError('membership lookup timeout must be between 0.1 and 2 seconds')
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.timeout_seconds = timeout_seconds
        self.opener = opener or build_opener(NoRedirect())
        self._membership_versions = OrderedDict()
        self._membership_versions_lock = threading.Lock()

    def _observe(self, key, tenant_id, roles, state, version):
        observed = (int(version), tenant_id, state, tuple(sorted(roles)))
        with self._membership_versions_lock:
            previous = self._membership_versions.get(key)
            if previous is not None:
                if observed[0] < previous[0] or (observed[0] == previous[0] and observed != previous):
                    raise ApiError(503, 'auth_unavailable')
            self._membership_versions[key] = observed
            self._membership_versions.move_to_end(key)
            while len(self._membership_versions) > 10000:
                self._membership_versions.popitem(last=False)

    def _observe_missing(self, key):
        with self._membership_versions_lock:
            previous = self._membership_versions.get(key)
            if previous is not None:
                self._membership_versions[key] = (previous[0], previous[1], 'missing', ())
                self._membership_versions.move_to_end(key)

    def check_readiness(self, *, issuer: str) -> None:
        """Check that the owner lookup endpoint accepts this service credential.

        The subject is a fixed, reserved non-user probe. A 404 is the expected
        response and proves both the route and service credential without
        depending on or logging a real user identity.
        """
        body = self._get('/v1/internal/memberships', {
            'issuer': issuer,
            'subject': 'greenguard-readiness-check-v1',
        })
        if body is not None:
            # A reserved probe identity should never be provisioned as a user.
            # Treat a valid owner response as reachable while keeping its body
            # out of logs and response payloads.
            try:
                _membership_shape(body)
            except (TypeError, ValueError, OverflowError) as exc:
                raise ApiError(503, 'auth_unavailable') from exc

    def _get(self, path, query):
        url = f"{self.base_url}{path}?{urlencode(query)}"
        request = Request(url, headers={'Accept':'application/json', 'Authorization':f'Bearer {self.token}'}, method='GET')
        try:
            with self.opener.open(request, timeout=self.timeout_seconds) as response:
                if response.status == 404:
                    return None
                raw = response.read(32769)
                if len(raw) > 32768 or response.status != 200:
                    raise ValueError('invalid membership response')
                return json.loads(raw)
        except HTTPError as exc:
            if exc.code == 404:
                return None
            raise ApiError(503, 'auth_unavailable') from exc
        except ApiError:
            raise
        except Exception as exc:
            # Do not expose upstream response bodies, service tokens, or transport details.
            raise ApiError(503, 'auth_unavailable') from exc

    def resolve(self, *, issuer: str, subject: str, tenant_id: str) -> ApiPrincipal:
        if not canonical_uuid(tenant_id):
            raise ApiError(400, 'invalid_tenant_selector')
        identity_id = identity_id_of(issuer, subject)
        version_key = ('human', identity_id)
        body = self._get('/v1/internal/memberships', {'issuer':issuer, 'subject':subject})
        if body is None:
            self._observe_missing(version_key)
            raise ApiError(403, 'membership_required')
        try:
            actual_tenant, roles, state, _ = _membership_shape(body)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ApiError(503, 'auth_unavailable') from exc
        self._observe(version_key, actual_tenant, roles, state, body['version'])
        if state != 'active' or actual_tenant != tenant_id:
            raise ApiError(403, 'membership_required')
        return ApiPrincipal(tenant_id, identity_id, max(roles, key=_ROLE_LEVEL.__getitem__))

    def resolve_delegated(self, *, subject: str, tenant_id: str) -> ApiPrincipal:
        if not canonical_uuid(tenant_id) or not canonical_uuid(subject):
            raise ApiError(400, 'invalid_tenant_selector')
        version_key = ('delegated', tenant_id, subject)
        body = self._get('/v1/internal/delegated-memberships', {'tenantId':tenant_id, 'identityId':subject})
        if body is None:
            self._observe_missing(version_key)
            raise ApiError(403, 'membership_required')
        try:
            actual_tenant, roles, state, identity_id = _membership_shape(body, delegated=True)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ApiError(503, 'auth_unavailable') from exc
        self._observe(version_key, actual_tenant, roles, state, body['version'])
        if state != 'active' or actual_tenant != tenant_id or identity_id != subject:
            raise ApiError(403, 'membership_required')
        return ApiPrincipal(tenant_id, identity_id, max(roles, key=_ROLE_LEVEL.__getitem__))

    def resolve_principal(self, *, principal_id: str, tenant_id: str) -> ApiPrincipal:
        """Refresh a queued human operation by its stable Control Plane identity ID."""
        return self.resolve_delegated(subject=principal_id, tenant_id=tenant_id)

class OidcAuthenticator:
    def __init__(self, *, issuer: str, audience: str, jwks_url: str, memberships,
                 cache_seconds: int=600, cooldown_seconds: int=30, max_token_seconds: int=3600,
                 allow_local_http: bool=False, delegated_mode: bool=False,
                 token_mode: str='audience', client_ids=()):
        for url in (issuer,jwks_url):
            if not configured_oidc_url(url,allow_local_http=allow_local_http):
                raise ValueError('OIDC issuer and JWKS URL require configured HTTPS endpoints')
        if token_mode not in {'audience', 'cognito-access'} or (token_mode == 'audience' and not audience) or (token_mode == 'cognito-access' and (audience or not client_ids)) or not 30<=cache_seconds<=3600 or not 1<=cooldown_seconds<=300 or not 60<=max_token_seconds<=86400:
            raise ValueError('invalid OIDC verification bounds')
        if not isinstance(client_ids, (list, tuple, set, frozenset)) or len(client_ids) > 16 or any(not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9]{8,128}', value) for value in client_ids):
            raise ValueError('invalid Cognito app-client allowlist')
        if token_mode == 'audience' and client_ids:
            raise ValueError('Cognito client IDs are only valid in cognito-access mode')
        if type(delegated_mode) is not bool:
            raise ValueError("invalid delegated verifier mode")
        self.delegated_mode=delegated_mode
        self.token_mode=token_mode
        self.client_ids=frozenset(client_ids)
        self.issuer=issuer; self.audience=audience; self.memberships=memberships
        self.uses_database_membership = bool(getattr(memberships, 'uses_database_membership', False))
        self.jwks_url=jwks_url; self.cache_seconds=cache_seconds
        self.cooldown_seconds=cooldown_seconds; self.max_token_seconds=max_token_seconds
        self._keys={}; self._expires=0.; self._next_refresh=0.
        self._lock=threading.Lock()
        self._opener=build_opener(NoRedirect())

    def check_readiness(self) -> None:
        check = getattr(self.memberships, 'check_readiness', None)
        if callable(check):
            check(issuer=self.issuer)

    def _key(self,kid: str):
        # An immutable published snapshot lets known keys avoid refresh I/O waits.
        snapshot = getattr(self, '_snapshot', None)
        if snapshot is not None and time.monotonic()<snapshot[0] and kid in snapshot[1]:
            return snapshot[1][kid]
        with self._lock:
            now=time.monotonic()
            if now<self._expires and kid in self._keys:
                return self._keys[kid]
            if now<self._next_refresh:
                raise ApiError(401,'invalid_token') if now<self._expires else ApiError(503,'auth_unavailable')
            self._next_refresh=now+self.cooldown_seconds
            try:
                with self._opener.open(Request(self.jwks_url,headers={'Accept':'application/json'}),timeout=5) as response:
                    raw=response.read(262145)
                if len(raw)>262144:
                    raise ValueError('JWKS exceeds bound')
                document=json.loads(raw)
                if not isinstance(document,dict) or not isinstance(document.get('keys'),list) or not 1<=len(document['keys'])<=32:
                    raise ValueError('invalid JWKS')
                keys={}
                for key in document['keys']:
                    if not isinstance(key,dict):
                        raise ValueError('invalid JWK')
                    if key.get('kty')!='RSA' or key.get('use','sig')!='sig' or key.get('alg','RS256')!='RS256':
                        continue
                    name=key.get('kid')
                    if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9._:/+=-]{1,128}',name) or name in keys:
                        raise ValueError('invalid/duplicate key ID')
                    if any(part in key for part in ('d','p','q','dp','dq','qi','oth')) or ('key_ops' in key and key['key_ops']!=['verify']):
                        raise ValueError('JWK is not a public verification key')
                    parsed=jwt.PyJWK.from_dict(key,algorithm='RS256')
                    if not 2048<=parsed.key.key_size<=8192:
                        raise ValueError('unsupported RSA key size')
                    keys[name]=parsed.key
                if not keys:
                    raise ValueError('no supported signing keys')
                self._keys=keys; self._expires=time.monotonic()+self.cache_seconds
                self._snapshot=(self._expires, keys)
            except Exception as exc:
                raise ApiError(503,'auth_unavailable') from exc
            if kid not in self._keys:
                raise ApiError(401,'invalid_token')
            return self._keys[kid]

    def __call__(self,authorization: str,tenant_selector: str) -> ApiPrincipal:
        match=re.fullmatch(r'(?i:Bearer) ([^\s]{1,16384})',authorization)
        if not match:
            raise ApiError(401,'unauthorized')
        token=match[1]
        try:
            header=jwt.get_unverified_header(token)
            kid=header.get('kid')
            if (header.get('alg')!='RS256' or header.get('typ','JWT') not in {'JWT','at+jwt'}
                    or not isinstance(kid,str) or not re.fullmatch(r'[A-Za-z0-9._:/+=-]{1,128}',kid)
                    or any(k in header for k in ('jku','x5u','jwk','crit'))):
                raise ValueError('invalid JOSE header')
            if self.token_mode == 'cognito-access' and self.delegated_mode:
                raise ValueError('delegated verifier cannot use Cognito access-token mode')
            claims=jwt.decode(token,self._key(kid),algorithms=['RS256'],issuer=self.issuer,
                              audience=self.audience if self.token_mode == 'audience' else None,leeway=5,
                              options={'require':['iss','aud','sub','exp','iat'] if self.token_mode == 'audience' else ['iss','sub','exp','iat'],
                                       'verify_aud': self.token_mode == 'audience'})
            if self.token_mode == 'cognito-access' and (
                claims.get('token_use') != 'access' or claims.get('client_id') not in self.client_ids or 'aud' in claims
                or not isinstance(claims.get('username'), str) or not claims.get('username')
                or type(claims.get('auth_time')) not in (int, float) or not math.isfinite(claims['auth_time'])
                or claims['sub'] == claims.get('client_id')
                or claims.get('grant_type') == 'client_credentials' or claims.get('gty') == 'client_credentials'
            ):
                raise ValueError('Cognito access token kind or client ID is invalid')
            delegated = claims.get('token_use') == 'delegated'
            if delegated != self.delegated_mode:
                raise ValueError('token kind does not match verifier mode')
            if (not isinstance(claims['sub'],str) or not 1<=len(claims['sub'])<=512
                    or type(claims['exp']) is not int or type(claims['iat']) is not int
                    or ('nbf' in claims and type(claims['nbf']) is not int)
                    or not 0<claims['exp']-claims['iat']<=self.max_token_seconds
                    or (not delegated and claims.get('token_use','access')!='access')
                    or (delegated and (set(claims) != {'iss','aud','sub','exp','iat','nbf','jti','tenant_id','roles','act','scope','token_use'}
                        or claims.get('scope') != 'knowledge:read' or claims.get('act') not in ({'sub':'grain-advisor'},{'sub':'greenguard-mcp'})
                        or not canonical_uuid(claims.get('sub')) or claims.get('tenant_id') != tenant_selector
                        or not isinstance(claims.get('roles'), list) or not claims['roles']))):
                raise ValueError('invalid identity claims')
        except ApiError:
            raise
        except (jwt.PyJWTError,ValueError,TypeError,KeyError,OverflowError,RecursionError) as exc:
            raise ApiError(401,'invalid_token') from exc
        # Ignore tenant/role/principal claims from the IdP and all caller role headers.
        if claims.get('token_use') == 'delegated':
            principal = self.memberships.resolve_delegated(subject=claims['sub'], tenant_id=tenant_selector)
            return ApiPrincipal(principal.tenant_id, principal.principal_id, principal.role, read_only=True)
        return self.memberships.resolve(issuer=self.issuer,subject=claims['sub'],tenant_id=tenant_selector)


class CompositeOidcAuthenticator:
    """Select the configured verifier by an untrusted issuer hint only.

    The selected verifier still validates signature, issuer, audience, token kind
    and current membership. A primary issuer outage cannot block a valid owner
    token from a different issuer. Unknown/malformed hints use the primary.
    """
    def __init__(self, primary: OidcAuthenticator, delegated: OidcAuthenticator | None = None):
        self.primary = primary
        self.delegated = delegated
        self.uses_database_membership = bool(
            getattr(primary.memberships, 'uses_database_membership', False)
            or (delegated is not None and getattr(delegated.memberships, 'uses_database_membership', False))
        )

    def __call__(self, authorization: str, tenant_selector: str) -> ApiPrincipal:
        if self.delegated is not None and isinstance(authorization, str) and len(authorization) <= 16384:
            match = re.fullmatch(r"(?i:Bearer) ([^\s]+)", authorization)
            if match:
                try:
                    hint = jwt.decode(match.group(1), options={"verify_signature": False})
                except (jwt.PyJWTError, ValueError, TypeError, RecursionError):
                    hint = {}
                if hint.get("iss") == self.delegated.issuer:
                    return self.delegated(authorization, tenant_selector)
        return self.primary(authorization, tenant_selector)

    def check_readiness(self) -> None:
        self.primary.check_readiness()
