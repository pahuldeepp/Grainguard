"""Current membership via owning control-plane API; no replicated auth table."""
import json
from urllib.parse import urlencode
from .owner_http import bounded_get
from .policy import uuid
from .owner_url import owner_origin_allowed

class ControlPlaneMemberships:
    def __init__(self,base_url,service_token, *, allow_mesh_http=False):
        if (not owner_origin_allowed(base_url, mesh_authority='tenant-control-plane.greenguard.svc.cluster.local:3010',
                                     allow_mesh_http=allow_mesh_http)
                or not isinstance(service_token,str) or not service_token or '\n' in service_token or '\r' in service_token):
            raise ValueError('unsafe control-plane membership configuration')
        self.base_url=base_url.rstrip('/');self.service_token=service_token
    def __call__(self,tenant,user):
        if not uuid(tenant) or not uuid(user):raise ValueError('invalid membership identity')
        url=self.base_url+'/v1/internal/delegated-memberships?'+urlencode({'tenantId':tenant,'identityId':user})
        status,raw=bounded_get(url,self.service_token,operation='Advisor.owner.membership')
        if status==404:return None
        if status!=200:raise ValueError('membership owner unavailable')
        value=json.loads(raw)
        if (not isinstance(value,dict) or value.get('tenantId')!=tenant or value.get('identityId')!=user
                or value.get('state')!='active' or not isinstance(value.get('roles'),list) or not value['roles']
                or any(role not in {'viewer','operator','admin','device'} for role in value['roles'])):raise ValueError('invalid owner membership result')
        return value['roles']
