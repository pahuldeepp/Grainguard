"""Fail-closed tool policy. Identity is supplied only by verified adapters."""
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import threading
import time
from uuid import UUID

ROLES={'viewer':1,'operator':2,'admin':3}
POLICY_PATH=Path(__file__).resolve().parents[3]/'ai/policy/tools.yaml'

class PolicyDenied(ValueError): pass


def uuid(value):
    try:return isinstance(value,str) and str(UUID(value))==value
    except (ValueError,AttributeError):return False

@dataclass(frozen=True)
class Principal:
    tenant_id:str
    user_id:str
    role:str
    audience:str
    expires_at:datetime

    def require(self,audience,min_role):
        if (not uuid(self.tenant_id) or not uuid(self.user_id) or self.role not in ROLES
                or self.audience!=audience or not isinstance(self.expires_at,datetime)
                or self.expires_at.tzinfo is None
                or self.expires_at<=datetime.now(timezone.utc)
                or ROLES[self.role]<ROLES[min_role]):
            raise PolicyDenied('identity_or_role_denied')


def load_policy(path=POLICY_PATH):
    # JSON is a YAML subset: one auditable policy, no new parser dependency.
    value=json.loads(Path(path).read_text())
    if (not isinstance(value,dict) or set(value)!={'version','max_calls','turn_seconds','tools'} or type(value['version']) is not int or value['version']!=1
            or type(value['max_calls']) is not int or value['max_calls']!=8 or type(value['turn_seconds']) is not int or value['turn_seconds']!=60
            or not isinstance(value['tools'],dict) or set(value['tools'])!={'search_knowledge','propose_acknowledge_alert'}):
        raise PolicyDenied('invalid_tool_policy')
    expected={'search_knowledge':('read','viewer','knowledge-service'), 'propose_acknowledge_alert':('propose','operator','grain-advisor')}
    for name,rule in value['tools'].items():
        if (not isinstance(rule,dict) or set(rule)!={'kind','min_role','audience','four_eyes'} or
                (rule['kind'],rule['min_role'],rule['audience'])!=expected[name]
                or type(rule['four_eyes']) is not bool):raise PolicyDenied('invalid_tool_policy')
    return value


def authorize_tool(principal,name,args,policy=None):
    policy=policy or load_policy()
    rule=policy['tools'].get(name)
    if rule is None:raise PolicyDenied('tool_not_allowed')
    principal.require(rule['audience'],rule['min_role'])
    if not isinstance(args,dict):raise PolicyDenied('invalid_tool_arguments')
    if name=='search_knowledge':
        if (set(args)!={'query','k'} or not isinstance(args['query'],str)
                or not 4<=len(args['query'].strip())<=2000
                or type(args['k']) is not int or not 1<=args['k']<=8):raise PolicyDenied('invalid_tool_arguments')
    else:
        if (set(args)!={'alert_id','note','etag'} or not uuid(args['alert_id'])
                or not isinstance(args['note'],str) or not 1<=len(args['note'])<=500
                or not isinstance(args['etag'],str) or not 1<=len(args['etag'])<=128):raise PolicyDenied('invalid_tool_arguments')
    return rule


class TurnBudget:
    """One request-scoped run; serialized admission, consumed even on failures.

    Durable distributed run counters are required before resumable MCP deployment.
    """
    def __init__(self,principal,run_id,clock=time.monotonic):
        if not uuid(run_id):raise PolicyDenied('invalid_run')
        self.identity=(principal.tenant_id,principal.user_id);self.run_id=run_id
        policy=load_policy();self.max_calls=policy['max_calls'];self.turn_seconds=policy['turn_seconds']
        self.clock=clock;self.started=clock();self.calls=0;self.lock=threading.Lock()
    def admit(self,principal):
        with self.lock:
            if ((principal.tenant_id,principal.user_id)!=self.identity
                    or self.clock()-self.started>=self.turn_seconds or self.calls>=self.max_calls):raise PolicyDenied('turn_budget_exhausted')
            self.calls+=1
