"""Fail-closed execution adapter for approved Alerts actions."""
import json
import re
from .owner_http import bounded_request
from .policy import uuid
from .owner_url import owner_origin_allowed


class ExecutionError(Exception):
    def __init__(self, code, retryable=False, receipt=None):
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.receipt = receipt


class AlertsExecutor:
    """Execute only the canonical acknowledge_alert action at workflow-alerts.

    The owner delegated token is supplied for one request and is never persisted
    or included in the execution receipt. The owner performs the final live
    membership, audience, scope and version checks.
    """
    def __init__(self, origin, *, allow_mesh_http=False):
        if not owner_origin_allowed(origin, mesh_authority='workflow-alerts.greenguard.svc.cluster.local:3004',
                                    allow_mesh_http=allow_mesh_http):
            raise ValueError('unsafe Alerts execution configuration')
        self.origin = (origin or '').rstrip('/')

    def __call__(self, principal, action, owner_token, idempotency_key):
        if principal.audience != 'grain-advisor' or principal.role not in {'operator','admin'}:
            raise ExecutionError('approver_not_authorized')
        if not isinstance(owner_token,str) or not re.fullmatch(r'Bearer [^\s]{32,16384}',owner_token):
            raise ExecutionError('owner_token_required')
        self._validate_action(action)
        if not uuid(idempotency_key):
            raise ExecutionError('invalid_execution_key')
        alert_id=action['target']; etag=action['preconditions']['etag']
        note=action['params']['note']
        try:
            status,raw=bounded_request(
                f'{self.origin}/v1/alerts/{alert_id}/acknowledge',
                owner_token.removeprefix('Bearer '),
                method='POST',
                headers={'If-Match':etag,'Idempotency-Key':idempotency_key,'Content-Type':'application/json'},
                body=json.dumps({'note':note},separators=(',',':')).encode(),
                operation='Advisor.owner.alert_acknowledgement',
            )
        except Exception as exc:
            raise ExecutionError('owner_unavailable',True) from exc
        if status in {401,403}:
            # A rotated or otherwise stale delegated token can be replaced on
            # the next approved retry; the proposal attempt cap bounds retries.
            raise ExecutionError('owner_authorization_failed',True)
        if status in {404,412}:
            raise ExecutionError('owner_version_conflict')
        if status == 409:
            raise ExecutionError('owner_idempotency_conflict')
        if status == 429 or status >= 500:
            raise ExecutionError('owner_retryable_failure',True)
        if status < 200 or status >= 300:
            raise ExecutionError('owner_request_denied')
        try:
            value=json.loads(raw.decode('utf-8')) if raw else {}
        except (ValueError,UnicodeDecodeError):
            value=None
        if not isinstance(value,dict) or len(value)>16:
            # The owner confirmed the mutation; never report it as failed just
            # because the optional response body is malformed.
            return {'status':status,'owner':'workflow-alerts','alert_id':alert_id,
                    'response':None,'response_invalid':True}
        return {'status':status,'owner':'workflow-alerts','alert_id':alert_id,'response':value}

    @staticmethod
    def _validate_action(action):
        if (not isinstance(action,dict) or set(action)!={'action','target','params','preconditions'}
                or action.get('action')!='acknowledge_alert' or not uuid(action.get('target'))
                or not isinstance(action.get('params'),dict) or set(action['params'])!={'note'}
                or not isinstance(action['params']['note'],str) or not 1<=len(action['params']['note'])<=500
                or not isinstance(action.get('preconditions'),dict) or set(action['preconditions'])!={'etag'}
                or not isinstance(action['preconditions']['etag'],str)
                or not re.fullmatch(r'"[1-9][0-9]{0,18}"',action['preconditions']['etag'])):
            raise ExecutionError('invalid_action')


def configured_executor(origin=None, *, allow_mesh_http=False):
    if not origin:
        def unavailable(*args):
            raise ExecutionError('owner_execution_unavailable',True)
        return unavailable
    return AlertsExecutor(origin,allow_mesh_http=allow_mesh_http)
