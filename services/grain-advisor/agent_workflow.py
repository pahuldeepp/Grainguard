"""Durable LangGraph approval workflow for owner-authorized actions.

The graph deliberately keeps the model and the owner credential outside the
checkpoint state.  The model can choose an allowlisted MCP tool, but it cannot
manufacture a proposal, an approval, a tenant, or a downstream token.  The
MCP adapter creates the proposal before the graph interrupts.  A human resumes
the same thread with the canonical hash/version decision; the graph then asks
the token provider for a fresh audience-scoped token and calls the existing
optimistic/idempotent Advisor execution path.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
import re
from typing import Any, Callable, Iterator, Literal, TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from advisor_security.policy import Principal, PolicyDenied, uuid
from advisor_security.proposals import Conflict, NotFound, decide
from advisor_security.execution import ExecutionError
from advisor_security.tracing import default_tracing, finish_span


Decision = Literal["approved", "rejected"]


class WorkflowState(TypedDict, total=False):
    tenant_id: str
    user_id: str
    role: str
    audience: str
    expires_at: str
    run_id: str
    question: str
    plan: dict[str, Any]
    proposal: dict[str, Any]
    approval: dict[str, Any]
    decision_result: dict[str, Any]
    error: str


Planner = Callable[[Principal, str], dict[str, Any]]
McpCall = Callable[[Principal, str, dict[str, Any]], dict[str, Any]]
TokenProvider = Callable[[Principal], str]
ExecuteAction = Callable[[Principal, dict[str, Any], str, str], dict[str, Any]]
DbFactory = Callable[[], Any]
_owner_token_context: ContextVar[str | None] = ContextVar("advisor_owner_token", default=None)
_principal_context: ContextVar[Principal | None] = ContextVar("advisor_fresh_principal", default=None)
MAX_APPROVAL_ATTEMPTS = 3


def request_owner_token(principal: Principal) -> str:
    """Read the one-request owner credential; it is never part of graph state."""
    principal.require("grain-advisor", "operator")
    value = _owner_token_context.get()
    if not isinstance(value, str) or not re.fullmatch(r"Bearer [^\s]{32,16384}", value):
        raise PolicyDenied("owner_token_required")
    return value


@dataclass(frozen=True)
class WorkflowDependencies:
    """Side effects used by the graph and kept out of checkpoint state."""

    db: DbFactory
    mcp_call: McpCall
    token_provider: TokenProvider
    execute_action: ExecuteAction
    planner: Planner


def principal_from_state(state: WorkflowState) -> Principal:
    """Rebuild and validate the verified caller identity from checkpoint data."""
    try:
        principal = Principal(
            tenant_id=state["tenant_id"],
            user_id=state["user_id"],
            role=state["role"],
            audience=state["audience"],
            expires_at=datetime.fromisoformat(state["expires_at"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise PolicyDenied("invalid_workflow_identity") from exc
    # The graph only accepts an already verified Advisor identity.  It never
    # upgrades a viewer or accepts an identity supplied by the model.
    principal.require("grain-advisor", "operator")
    return principal


def _run_id(value: str) -> str:
    if not uuid(value):
        raise PolicyDenied("invalid_run")
    return value


def _proposal_view(proposal: dict[str, Any]) -> dict[str, Any]:
    """Return only the canonical fields the reviewer must see."""
    required = {"proposal_id", "action_hash", "status", "version", "expires_at", "action"}
    if not isinstance(proposal, dict) or not required <= set(proposal):
        raise PolicyDenied("invalid_proposal")
    if not uuid(proposal["proposal_id"]) or not isinstance(proposal["action_hash"], str):
        raise PolicyDenied("invalid_proposal")
    if len(proposal["action_hash"]) != 64 or not isinstance(proposal["action"], dict):
        raise PolicyDenied("invalid_proposal")
    return {key: proposal[key] for key in required}


def _approval(value: Any, proposal: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"decision", "action_hash", "version", "request_id"}:
        raise PolicyDenied("invalid_approval")
    if value["decision"] not in {"approved", "rejected"}:
        raise PolicyDenied("invalid_approval")
    if value["action_hash"] != proposal["action_hash"] or value["version"] != proposal["version"]:
        raise Conflict("proposal_version_conflict")
    if not uuid(value["request_id"]):
        raise PolicyDenied("invalid_approval")
    return {
        "decision": value["decision"],
        "action_hash": value["action_hash"],
        "version": value["version"],
        "request_id": value["request_id"],
    }


def build_workflow(deps: WorkflowDependencies, *, checkpointer: Any | None = None,
                   tracing=None):
    """Compile the approval graph with a durable or test checkpointer.

    ``checkpointer`` should be a ``PostgresSaver`` in a deployed runtime.  The
    in-memory saver is only the explicit local/unit-test fallback.
    """
    if checkpointer is None:
        checkpointer = InMemorySaver()
    tracing = tracing or default_tracing()

    def traced_node(operation: str, node):
        def run(state: WorkflowState) -> WorkflowState:
            with tracing.span(operation) as span:
                try:
                    result = node(state)
                    finish_span(span, outcome="success")
                    return result
                except BaseException:
                    # No exception text or workflow state is recorded.
                    finish_span(span, outcome="error")
                    raise
        return run

    def plan(state: WorkflowState) -> WorkflowState:
        principal = principal_from_state(state)
        planned = deps.planner(principal, state["question"])
        if not isinstance(planned, dict) or planned.get("tool") != "propose_acknowledge_alert":
            raise PolicyDenied("tool_not_allowed")
        args = planned.get("args")
        if not isinstance(args, dict):
            raise PolicyDenied("invalid_tool_arguments")
        return {"plan": {"tool": planned["tool"], "args": dict(args)}}

    def mcp_tool(state: WorkflowState) -> WorkflowState:
        principal = principal_from_state(state)
        plan_value = state.get("plan")
        if not isinstance(plan_value, dict) or plan_value.get("tool") != "propose_acknowledge_alert":
            raise PolicyDenied("invalid_tool_plan")
        proposal = deps.mcp_call(principal, plan_value["tool"], plan_value["args"])
        return {"proposal": _proposal_view(proposal)}

    def await_approval(state: WorkflowState) -> WorkflowState:
        # This is the only interrupt.  The payload is server-rendered from the
        # persisted proposal, so approval text cannot be substituted by model
        # prose.  LangGraph checkpoints before returning this interrupt.
        # Re-validate the checkpointed proposal before every human resume. The
        # model/UI never gets to replace the canonical action hash or version.
        proposal = _proposal_view(state.get("proposal"))
        for _attempt in range(MAX_APPROVAL_ATTEMPTS):
            response = interrupt({"type": "approval_required", "proposal": proposal})
            try:
                return {"approval": _approval(response, proposal)}
            except Conflict:
                # A stale UI or tampered payload must leave the same durable
                # thread resumable.  Re-render the canonical proposal instead
                # of consuming the interrupt or accepting client-supplied data.
                continue
            except PolicyDenied:
                # The caller can retry with the exact schema; no model state or
                # owner credential is changed by an invalid approval payload.
                continue
        raise PolicyDenied("approval_attempt_limit")

    def apply_approval(state: WorkflowState) -> WorkflowState:
        principal = _principal_context.get()
        if principal is None:
            raise PolicyDenied("fresh_approver_required")
        if principal.tenant_id != state["tenant_id"]:
            raise PolicyDenied("workflow_identity_mismatch")
        principal.require("grain-advisor", "operator")
        proposal = _proposal_view(state["proposal"])
        approval = _approval(state.get("approval"), proposal)
        if approval["decision"] == "approved":
            # Token material is obtained only after the approval is validated;
            # it is never written to LangGraph state/checkpoints.
            owner_token = deps.token_provider(principal)
            if not isinstance(owner_token, str) or not owner_token.startswith("Bearer "):
                raise PolicyDenied("owner_token_required")
        else:
            owner_token = None
        with deps.db() as db:
            result = decide(
                db,
                principal,
                proposal["proposal_id"],
                decision=approval["decision"],
                action_hash=approval["action_hash"],
                version=approval["version"],
                request_id=approval["request_id"],
                execute_action=deps.execute_action if owner_token else None,
                owner_token=owner_token,
            )
        return {"decision_result": result}

    builder = StateGraph(WorkflowState)
    builder.add_node("plan", traced_node("Advisor.workflow.plan", plan))
    builder.add_node("mcp_tool", traced_node("Advisor.workflow.owner_tool", mcp_tool))
    builder.add_node("await_approval", await_approval)
    builder.add_node("apply_approval", traced_node("Advisor.workflow.apply_approval", apply_approval))
    builder.add_conditional_edges(
        START,
        lambda state: "await_approval" if state.get("proposal") else "plan",
        {"await_approval": "await_approval", "plan": "plan"},
    )
    builder.add_edge("plan", "mcp_tool")
    builder.add_edge("mcp_tool", "await_approval")
    builder.add_edge("await_approval", "apply_approval")
    builder.add_edge("apply_approval", END)
    return builder.compile(checkpointer=checkpointer)


def thread_config(principal: Principal, run_id: str, *, proposal_thread: bool = False) -> dict[str, Any]:
    """Return a tenant/user-bound checkpoint key for a workflow thread."""
    principal.require("grain-advisor", "operator")
    _run_id(run_id)
    return {
        "configurable": {
            "thread_id": (f"{principal.tenant_id}:proposal:{run_id}" if proposal_thread
                          else f"{principal.tenant_id}:{principal.user_id}:{run_id}"),
            "tenant_id": principal.tenant_id,
            "user_id": principal.user_id,
        }
    }


def initial_state(principal: Principal, run_id: str, question: str) -> WorkflowState:
    principal.require("grain-advisor", "operator")
    if not isinstance(question, str) or not 1 <= len(question.strip()) <= 2000:
        raise PolicyDenied("invalid_question")
    _run_id(run_id)
    return {
        "tenant_id": principal.tenant_id,
        "user_id": principal.user_id,
        "role": principal.role,
        "audience": principal.audience,
        "expires_at": principal.expires_at.isoformat(),
        "run_id": run_id,
        "question": question,
    }


def start(graph: Any, principal: Principal, run_id: str, question: str) -> dict[str, Any]:
    """Start a workflow; returns an interrupt when human approval is needed."""
    return graph.invoke(initial_state(principal, run_id, question), config=thread_config(principal, run_id))


def start_existing_proposal(graph: Any, principal: Principal, run_id: str,
                            proposal: dict[str, Any]) -> dict[str, Any]:
    """Checkpoint a proposal created by the authenticated MCP/Advisor path."""
    state = initial_state(principal, run_id, "Review the proposed alert acknowledgement.")
    state["proposal"] = _proposal_view(proposal)
    # One proposal per checkpoint prevents two alerts on one agent run from
    # competing for a single human-approval interrupt.
    config = thread_config(principal, state["proposal"]["proposal_id"], proposal_thread=True)
    existing = graph.get_state(config)
    if existing.values:
        prior = existing.values.get("proposal")
        if prior != state["proposal"] or existing.values.get("tenant_id") != principal.tenant_id:
            raise Conflict("workflow_thread_conflict")
        return dict(existing.values)
    return graph.invoke(state, config=config)


def resume(graph: Any, principal: Principal, run_id: str, approval: dict[str, Any],
           owner_token: str | None = None, *, db: DbFactory | None = None,
           require_owner_token: bool = False) -> dict[str, Any]:
    """Resume the exact checkpoint with a canonical human decision."""
    _run_id(run_id)
    config = thread_config(principal, run_id, proposal_thread=True)
    current = graph.get_state(config)
    # Planner-created workflows use user/run keys; the HTTP adapter's proposal
    # lifecycle uses tenant/proposal keys so a different authorized operator
    # can approve. Select only an existing checkpoint and then enforce tenant.
    if not current.values:
        config = thread_config(principal, run_id)
        current = graph.get_state(config)
    identity = current.values
    if not identity:
        raise NotFound("workflow_checkpoint_missing")
    if (not identity or identity.get("tenant_id") != principal.tenant_id
            or not identity.get("proposal")):
        raise PolicyDenied("workflow_identity_mismatch")
    existing_approval = identity.get("approval")
    if require_owner_token and isinstance(approval, dict) and approval.get("decision") == "approved" and not owner_token:
        raise PolicyDenied("owner_token_required")
    resume_value: Any = Command(resume=approval)
    if existing_approval is not None:
        requested = _approval(approval, identity["proposal"])
        if any(existing_approval.get(key) != requested[key]
               for key in ("decision", "action_hash", "version")):
            # The graph checkpoints the human input before its DB node runs.
            # If that node failed before the DB decision committed, allow the
            # authorized reviewer to make a new choice against the still-pending
            # canonical row. Once committed, the row is no longer pending.
            if db is None:
                raise Conflict("workflow_decision_conflict")
            with db() as connection:
                from advisor_security.proposals import scope
                with connection.transaction():
                    scope(connection, principal)
                    row=connection.execute('''SELECT status,version,action_hash FROM action_proposals
                                              WHERE tenant_id=%s AND proposal_id=%s''',
                                           (principal.tenant_id,identity["proposal"]["proposal_id"])).fetchone()
            if (row is None or row[0] != "pending" or row[1] != requested["version"]
                    or row[2] != requested["action_hash"]):
                raise Conflict("workflow_decision_conflict")
            graph.update_state(config, {"approval": requested}, as_node="await_approval")
            resume_value = None
        else:
            resume_value = None
        if identity.get("decision_result") is not None and resume_value is None:
            if existing_approval != requested:
                raise Conflict("workflow_decision_conflict")
            return dict(identity)
        # Retry the failed apply_approval node with the already checkpointed
        # request ID and fresh request-local credentials; don't replay or
        # replace the approval event.
        # ``None`` retries the checkpointed approval node; ``Command`` replaces
        # the choice only while the canonical DB row is still pending.
    token = _owner_token_context.set(owner_token)
    principal_token = _principal_context.set(principal)
    try:
        result = graph.invoke(resume_value, config=config)
        if isinstance(result, dict) and result.get("__interrupt__"):
            raise Conflict("proposal_version_conflict")
        if not isinstance(result, dict) or not isinstance(result.get("decision_result"), dict):
            raise ExecutionError("workflow_incomplete", True)
        return result
    finally:
        _owner_token_context.reset(token)
        _principal_context.reset(principal_token)


@contextmanager
def postgres_checkpointer(dsn: str, *, setup: bool = False) -> Iterator[Any]:
    """Open LangGraph's Postgres saver for deployed durable checkpoints.

    Run ``setup=True`` only from a migration job using the checkpoint schema
    owner.  Runtime pods should use a restricted role after that schema is
    provisioned.
    """
    from langgraph.checkpoint.postgres import PostgresSaver
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool

    pool = ConnectionPool(
        dsn,
        min_size=1,
        max_size=8,
        timeout=3,
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
        check=ConnectionPool.check_connection,
        open=False,
    )
    with pool:
        saver = PostgresSaver(pool)
        if setup:
            saver.setup()
        yield saver


__all__ = [
    "WorkflowDependencies",
    "WorkflowState",
    "build_workflow",
    "initial_state",
    "request_owner_token",
    "postgres_checkpointer",
    "resume",
    "start",
    "start_existing_proposal",
    "thread_config",
]
