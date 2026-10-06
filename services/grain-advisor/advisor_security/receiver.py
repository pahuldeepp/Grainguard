"""Configured delegated receiver; target ownership always needs its owner adapter."""
import psycopg
from contextlib import nullcontext
from .delegated import DelegatedVerifier
from .http_api import create_server
from .jwks import PublicJwks
from .membership import ControlPlaneMemberships
from .alerts import configured_owner
from .execution import configured_executor
from .owner_http import bounded_get
from .tracing import AdvisorTracing, set_default_tracing


_DEFAULT_OWNER=object()

def configured_server(*,issuer,jwks_url,membership_url,membership_service_token,
                      database_url,workflow_database_url=None,authorize_alert=_DEFAULT_OWNER,
                      alerts_origin=None,alerts_service_token=None,host='127.0.0.1',port=8088,key_resolver=None,allow_mesh_http=False):
    tracing=AdvisorTracing()
    set_default_tracing(tracing)
    if authorize_alert is _DEFAULT_OWNER:authorize_alert=configured_owner(alerts_origin,alerts_service_token,allow_mesh_http=allow_mesh_http)
    if not database_url or not callable(authorize_alert):
        raise ValueError('database and owning Alerts authorization adapter required')
    keys=key_resolver if key_resolver is not None else PublicJwks(jwks_url)
    membership=ControlPlaneMemberships(membership_url,membership_service_token,allow_mesh_http=allow_mesh_http)
    verifiers={scope:DelegatedVerifier(issuer=issuer,audience='grain-advisor',scope=scope,
        key_resolver=keys,membership=membership) for scope in ('advisor:propose','advisor:decide')}
    connect=lambda:psycopg.connect(database_url,connect_timeout=3)
    workflow_context=nullcontext(None)
    workflow_start=workflow_resume=None
    workflow_saver=None
    if workflow_database_url:
        if not alerts_origin:
            raise ValueError('durable approval workflow requires the Alerts owner executor')
        from agent_workflow import (WorkflowDependencies,build_workflow,postgres_checkpointer,
                                    request_owner_token,start_existing_proposal,resume)
        from .policy import PolicyDenied
        executor=configured_executor(alerts_origin,allow_mesh_http=allow_mesh_http)
        def unavailable_planner(*_):raise PolicyDenied('planner_not_configured')
        def unavailable_mcp(*_):raise PolicyDenied('mcp_not_configured')
        workflow_context=postgres_checkpointer(workflow_database_url)
        saver=workflow_context.__enter__()
        workflow_saver=saver
        graph=build_workflow(WorkflowDependencies(db=connect,mcp_call=unavailable_mcp,
            token_provider=request_owner_token,execute_action=executor,planner=unavailable_planner),
            checkpointer=saver,tracing=tracing)
        workflow_start=lambda principal,run_id,proposal:start_existing_proposal(graph,principal,run_id,proposal)
        workflow_resume=lambda principal,run_id,approval,owner_token:resume(
            graph,principal,run_id,approval,owner_token,db=connect,require_owner_token=True)
    def healthcheck():
        with connect() as db:
            db.execute('SELECT 1')
        if workflow_saver is not None:
            with workflow_saver.conn.connection() as db:
                db.execute('SELECT 1')
        # Readiness must reflect the security and mutation owners too. Probe
        # membership using a canonical non-user identity (404 means the owner
        # is reachable and correctly reports no membership); this never grants
        # or caches a real principal's authority.
        probe_id='00000000-0000-4000-8000-000000000001'
        membership(probe_id,probe_id)
        if not alerts_origin:
            return False
        status,_=bounded_get(alerts_origin.rstrip('/')+'/readyz',None,operation='Advisor.owner.readiness')
        if status!=200:
            return False
        return True

    server=create_server(connect=connect,healthcheck=healthcheck,
        verifier=verifiers.__getitem__,authorize_alert=authorize_alert,
        execute_action=configured_executor(alerts_origin,allow_mesh_http=allow_mesh_http),workflow_start=workflow_start,
        workflow_resume=workflow_resume,host=host,port=port,tracing=tracing)
    server.advisor_tracing=tracing
    # The saver holds a pool open for the lifetime of the receiver.
    if workflow_start is not None:
        server.workflow_context=workflow_context
    return server
