"""RS256 delegated-token receiver; current membership must be authoritative."""
from datetime import datetime,timezone
import re
from urllib.parse import urlsplit
import jwt
from .policy import Principal,PolicyDenied,uuid

SCOPES={'grain-advisor':{'advisor:propose','advisor:decide'},'greenguard-mcp':{'tools:read','tools:propose'},'knowledge-service':{'knowledge:read'},'read-api':{'telemetry:read'},'workflow-alerts':{'alerts:read','alerts:acknowledge'}}
WRITE={'advisor:propose','advisor:decide','tools:propose','alerts:acknowledge'}
ROLES={'viewer':1,'operator':2,'admin':3}

class DelegationError(PolicyDenied):
    def __init__(self,status,code):super().__init__(code);self.status=status


class DelegatedVerifier:
    def __init__(self,*,issuer,audience,scope,key_resolver,membership):
        origin=urlsplit(issuer)
        if (origin.scheme!='https' or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment
                or scope not in SCOPES.get(audience,set()) or not callable(key_resolver) or not callable(membership)):
            raise ValueError('invalid delegation receiver configuration')
        self.issuer=issuer;self.audience=audience;self.scope=scope
        self.key_resolver=key_resolver;self.membership=membership

    def verify(self,authorization,tenant_selector=None):
        match=re.fullmatch(r'(?i:Bearer) ([^\s]{1,16384})',authorization or '')
        if not match:raise DelegationError(401,'invalid_delegated_token')
        token=match[1]
        try:
            header=jwt.get_unverified_header(token)
            if (set(header)!={'alg','typ','kid'} or header['alg']!='RS256' or header['typ']!='at+jwt'
                    or not isinstance(header['kid'],str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,128}',header['kid'])):raise ValueError()
            try:key=self.key_resolver(header['kid'])
            except Exception as exc:raise DelegationError(503,'delegation_keys_unavailable') from exc
            if key is None:raise ValueError()
            claims=jwt.decode(token,key,algorithms=['RS256'],issuer=self.issuer,audience=self.audience,leeway=0,
                options={'require':['iss','aud','sub','exp','iat','nbf','jti']})
            if (set(claims)!={'iss','aud','sub','exp','iat','nbf','jti','tenant_id','roles','act','scope','token_use'} or claims['aud']!=self.audience or claims.get('scope')!=self.scope or claims.get('token_use')!='delegated'
                    or claims.get('act') not in (({'sub':'grain-advisor'},{'sub':'greenguard-mcp'}) if self.scope=='advisor:propose' else ({'sub':'grain-advisor'},)) or not uuid(claims['sub'])
                    or not uuid(claims.get('tenant_id')) or not uuid(claims['jti'])
                    or any(type(claims[k]) is not int for k in ('iat','exp','nbf'))
                    or not 0<claims['exp']-claims['iat']<=300 or claims['nbf']!=claims['iat']
                    or not isinstance(claims.get('roles'),list) or not claims['roles']
                    or any(role not in ROLES for role in claims['roles'])):raise ValueError()
        except DelegationError:raise
        except (jwt.PyJWTError,ValueError,TypeError,KeyError,OverflowError,RecursionError) as exc:raise DelegationError(401,'invalid_delegated_token') from exc
        if tenant_selector is not None and tenant_selector!=claims['tenant_id']:raise DelegationError(403,'tenant_mismatch')
        try:current=self.membership(claims['tenant_id'],claims['sub'])
        except Exception as exc:raise DelegationError(503,'membership_unavailable') from exc
        if claims['exp']<=datetime.now(timezone.utc).timestamp():raise DelegationError(401,'expired_delegated_token')
        if not current:raise DelegationError(403,'membership_required')
        if not isinstance(current,(list,tuple)) or any(not isinstance(role,str) or role not in {*ROLES,'device'} for role in current):raise DelegationError(503,'invalid_membership')
        effective=set(claims['roles']) & set(current)
        if not effective or (self.scope in WRITE and not effective & {'operator','admin'}):raise DelegationError(403,'insufficient_role')
        return Principal(claims['tenant_id'],claims['sub'],max(effective,key=ROLES.get),self.audience,datetime.fromtimestamp(claims['exp'],timezone.utc))
