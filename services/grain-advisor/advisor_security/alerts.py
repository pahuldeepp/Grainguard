"""Read-only owning Alerts authorization; only verified principal supplies identity."""
import json
import re
from urllib.parse import urlencode
from .owner_http import bounded_get
from .policy import uuid
from .delegated import DelegationError
from .http_api import closed_object
from .owner_url import owner_origin_allowed

class AlertsOwnership:
    def __init__(self, origin, service_token, *, allow_mesh_http=False):
        if (not owner_origin_allowed(origin, mesh_authority='workflow-alerts.greenguard.svc.cluster.local:3004',
                                     allow_mesh_http=allow_mesh_http)
                or not isinstance(service_token,str) or not re.fullmatch(r'[!-~]{32,512}',service_token)):
            raise ValueError('unsafe Alerts ownership configuration')
        self.origin=origin.rstrip('/');self.service_token=service_token
    def __call__(self,principal,alert_id,etag):
        principal.require('grain-advisor','operator')
        if not uuid(alert_id) or not isinstance(etag,str) or not re.fullmatch(r'"[1-9][0-9]{0,18}"',etag):
            raise ValueError('invalid alert selector')
        selectors={'tenantId':principal.tenant_id,'userId':principal.user_id,'alertId':alert_id,'etag':etag}
        try:
            status,raw=bounded_get(self.origin+'/v1/internal/alert-authorization?'+urlencode(selectors),self.service_token,operation='Advisor.owner.alert_authorization')
            if status in {403,404}:return False
            if status!=200:raise ValueError('invalid owner status')
            value=json.loads(raw,object_pairs_hook=closed_object)
            if not isinstance(value,dict) or set(value)!={'authorized',*selectors} or value.get('authorized') is not True or any(value.get(key)!=item for key,item in selectors.items()):raise ValueError('invalid owner receipt')
            return True
        except Exception as exc:
            raise DelegationError(503,'alert_authorization_unavailable') from exc


def configured_owner(origin=None,service_token=None, *, allow_mesh_http=False):
    if origin is None and service_token is None:
        def unavailable(*args):raise DelegationError(503,'alert_authorization_unavailable')
        return unavailable
    if not origin or not service_token:raise ValueError('Alerts ownership origin and token must be set together')
    return AlertsOwnership(origin,service_token,allow_mesh_http=allow_mesh_http)
