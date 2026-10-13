"""Dependency-injected tool boundary; no shell, URL, SQL or action executor."""
import json
from .policy import authorize_tool, PolicyDenied
from .proposals import audit, scope, propose


def call(db,principal,budget,name,args,*,knowledge):
    safe_name=name if name in {'search_knowledge','propose_acknowledge_alert'} else 'unknown'
    # Admit before policy validation so rejected model attempts also consume
    # the bounded turn budget. Exhausted attempts are rejected without writes.
    budget.admit(principal)
    try:
        rule=authorize_tool(principal,name,args)
    except PolicyDenied:
        # Only already verified, valid identity may write a scoped denial.
        principal.require(principal.audience,'viewer')
        with db.transaction():scope(db,principal);audit(db,principal,'tool_denied',tool=safe_name)
        raise
    with db.transaction():
        scope(db,principal);audit(db,principal,'tool_allowed',tool=safe_name)
        if rule['kind']=='propose':return propose(db,principal,budget.run_id,args)
    # Adapter receives tenant/user from verified principal, never model args.
    # Owning Knowledge API enforces source ACL and output guardrails.
    result=knowledge(principal,args['query'],args['k'])
    if (not isinstance(result,dict) or set(result)!={'answer','citations','retrieval'}
            or not isinstance(result['answer'],str) or not isinstance(result['citations'],(list,tuple))
            or len(result['citations'])>args['k'] or not isinstance(result['retrieval'],dict)
            or len(json.dumps(result,allow_nan=False).encode())>32768):
        raise PolicyDenied('invalid_tool_result')
    return result
