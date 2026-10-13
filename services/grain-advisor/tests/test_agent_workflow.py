import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from unittest.mock import patch

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command
from advisor_security.policy import Principal, PolicyDenied
from advisor_security.proposals import Conflict, NotFound
from agent_workflow import (MAX_APPROVAL_ATTEMPTS, WorkflowDependencies, _approval,
                            build_workflow, request_owner_token, resume, start,
                            start_existing_proposal, thread_config)


class Db:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class PendingDb:
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def transaction(self): return self
    def execute(self, *_args): return self
    def fetchone(self): return ("pending", 1, "a" * 64)


class AgentWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.principal = Principal(
            str(uuid4()), str(uuid4()), "operator", "grain-advisor",
            datetime.now(timezone.utc) + timedelta(minutes=5),
        )
        self.run_id = str(uuid4())
        self.proposal = {
            "proposal_id": str(uuid4()),
            "action_hash": "a" * 64,
            "status": "pending",
            "version": 1,
            "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
            "action": {
                "action": "acknowledge_alert",
                "target": str(uuid4()),
                "params": {"note": "reviewed"},
                "preconditions": {"etag": '"v1"'},
            },
        }

    def dependencies(self, calls):
        def planner(principal, question):
            calls.append(("plan", principal.tenant_id, question))
            return {
                "tool": "propose_acknowledge_alert",
                "args": {
                    "alert_id": self.proposal["action"]["target"],
                    "note": "reviewed",
                    "etag": '"v1"',
                },
            }

        def mcp(principal, tool, args):
            calls.append(("mcp", principal.tenant_id, tool, args))
            return self.proposal

        def token(principal):
            calls.append(("token", principal.tenant_id))
            return "Bearer fresh-owner-token"

        def execute(principal, action, owner_token, key):
            calls.append(("execute", owner_token, key, action))
            return {"status": 200, "idempotency_key": key}

        return WorkflowDependencies(
            db=Db,
            mcp_call=mcp,
            token_provider=token,
            execute_action=execute,
            planner=planner,
        )

    def test_pause_resume_uses_exact_proposal_and_fresh_token(self):
        calls = []
        saver = InMemorySaver()
        deps = self.dependencies(calls)
        graph = build_workflow(deps, checkpointer=saver)
        first = start(graph, self.principal, self.run_id, "acknowledge this alert")
        self.assertIn("__interrupt__", first)
        interrupt_value = first["__interrupt__"][0].value
        self.assertEqual(interrupt_value["proposal"]["action_hash"], "a" * 64)
        self.assertEqual([c[0] for c in calls], ["plan", "mcp"])
        self.assertNotIn("owner_token", str(first))

        with self.assertRaises(Conflict):
            resume(graph, self.principal, self.run_id, {
                "decision": "approved",
                "action_hash": "b" * 64,
                "version": 1,
                "request_id": str(uuid4()),
            })

        with patch("agent_workflow.decide", return_value={
            "status": "approved",
            "execution_status": "succeeded",
            "execution_receipt": {"status": 200},
        }) as decision:
            final = resume(graph, self.principal, self.run_id, {
                "decision": "approved",
                "action_hash": "a" * 64,
                "version": 1,
                "request_id": str(uuid4()),
            })
        self.assertEqual(final["decision_result"]["execution_status"], "succeeded")
        self.assertEqual([c[0] for c in calls], ["plan", "mcp", "token"])
        decision.assert_called_once()
        self.assertEqual(decision.call_args.kwargs["owner_token"], "Bearer fresh-owner-token")

    def test_checkpoint_can_resume_with_a_new_graph_instance(self):
        calls = []
        saver = InMemorySaver()
        deps = self.dependencies(calls)
        graph = build_workflow(deps, checkpointer=saver)
        start(graph, self.principal, self.run_id, "acknowledge this alert")

        # A worker crash/restart creates a new compiled graph against the same
        # durable checkpointer; the interrupt remains resumable.
        restarted = build_workflow(deps, checkpointer=saver)
        with patch("agent_workflow.decide", return_value={
            "status": "rejected",
            "execution_status": "not_applicable",
            "execution_receipt": None,
        }):
            final = resume(restarted, self.principal, self.run_id, {
                "decision": "rejected",
                "action_hash": "a" * 64,
                "version": 1,
                "request_id": str(uuid4()),
            })
        self.assertEqual(final["decision_result"]["status"], "rejected")
        self.assertNotIn("token", [c[0] for c in calls])

    def test_existing_mcp_proposal_pauses_then_resumes_with_fresh_ephemeral_identity(self):
        calls = []
        deps = self.dependencies(calls)
        deps = WorkflowDependencies(db=deps.db, mcp_call=deps.mcp_call,
            token_provider=request_owner_token, execute_action=deps.execute_action,
            planner=deps.planner)
        graph = build_workflow(deps, checkpointer=InMemorySaver())
        first = start_existing_proposal(graph, self.principal, self.run_id, self.proposal)
        self.assertIn("__interrupt__", first)
        self.assertEqual(first["__interrupt__"][0].value["proposal"], self.proposal)
        self.assertEqual(calls, [])
        second = {**self.proposal, "proposal_id": str(uuid4()), "action_hash": "b" * 64,
                  "action": {**self.proposal["action"], "target": str(uuid4())}}
        second_thread = start_existing_proposal(graph, self.principal, self.run_id, second)
        self.assertIn("__interrupt__", second_thread)
        self.assertEqual(second_thread["__interrupt__"][0].value["proposal"], second)
        foreign = Principal(str(uuid4()), self.principal.user_id, "operator", "grain-advisor",
            datetime.now(timezone.utc) + timedelta(minutes=10))
        with self.assertRaises(NotFound):
            resume(graph, foreign, self.proposal["proposal_id"], {"decision": "rejected", "action_hash": "a" * 64,
                "version": 1, "request_id": str(uuid4())})
        refreshed = Principal(self.principal.tenant_id, self.principal.user_id, "operator", "grain-advisor",
            datetime.now(timezone.utc) + timedelta(minutes=10))
        approval = {"decision": "approved", "action_hash": "a" * 64,
                    "version": 1, "request_id": str(uuid4())}
        owner_token = "Bearer " + ("o" * 40)
        with patch("agent_workflow.decide", return_value={"status": "approved", "execution_status": "succeeded"}) as decision:
            final = resume(graph, refreshed, self.proposal["proposal_id"], approval, owner_token)
        self.assertEqual(final["decision_result"]["execution_status"], "succeeded")
        self.assertEqual(decision.call_args.kwargs["owner_token"], owner_token)
        duplicate = resume(graph, refreshed, self.proposal["proposal_id"], approval, owner_token)
        self.assertEqual(duplicate["decision_result"], final["decision_result"])
        decision.assert_called_once()
        self.assertNotIn(owner_token, str(final))
        stored = graph.get_state(thread_config(refreshed, self.proposal["proposal_id"], proposal_thread=True)).values
        self.assertTrue(stored.get("decision_result"))
        self.assertNotIn(owner_token, str(stored))

    def test_workflow_requires_operator_identity(self):
        viewer = Principal(
            self.principal.tenant_id, self.principal.user_id, "viewer", "grain-advisor",
            self.principal.expires_at,
        )
        with self.assertRaises(PolicyDenied):
            start(build_workflow(self.dependencies([])), viewer, self.run_id, "action")

    def test_uncommitted_approval_can_be_replaced_if_database_row_is_pending(self):
        deps = self.dependencies([])
        deps = WorkflowDependencies(db=deps.db, mcp_call=deps.mcp_call,
            token_provider=request_owner_token, execute_action=deps.execute_action,
            planner=deps.planner)
        graph = build_workflow(deps, checkpointer=InMemorySaver())
        start_existing_proposal(graph, self.principal, self.run_id, self.proposal)
        approved = {"decision": "approved", "action_hash": "a" * 64,
            "version": 1, "request_id": str(uuid4())}
        with self.assertRaises(PolicyDenied):
            resume(graph, self.principal, self.proposal["proposal_id"], approved,
                require_owner_token=True)
        # A valid token reaches the node, but a transient pre-commit failure
        # leaves only a checkpointed approval and the DB row still pending.
        with patch("agent_workflow.decide", side_effect=RuntimeError("db unavailable")):
            with self.assertRaises(RuntimeError):
                resume(graph, self.principal, self.proposal["proposal_id"], approved,
                    "Bearer " + ("o" * 40))
        rejected = {"decision": "rejected", "action_hash": "a" * 64,
            "version": 1, "request_id": str(uuid4())}
        with patch("agent_workflow.decide", return_value={"status": "rejected"}) as decision:
            result = resume(graph, self.principal, self.proposal["proposal_id"], rejected,
                db=PendingDb)
        self.assertEqual(result["decision_result"]["status"], "rejected")
        decision.assert_called_once()

    def test_approval_checkpoint_is_bound_to_canonical_proposal(self):
        with self.assertRaises(Conflict):
            _approval({"decision": "approved", "action_hash": "b" * 64,
                       "version": 1, "request_id": str(uuid4())}, self.proposal)
        with self.assertRaises(Conflict):
            _approval({"decision": "approved", "action_hash": "a" * 64,
                       "version": 2, "request_id": str(uuid4())}, self.proposal)

    def test_invalid_human_approval_has_a_bounded_retry_count(self):
        graph = build_workflow(self.dependencies([]), checkpointer=InMemorySaver())
        first = start(graph, self.principal, self.run_id, "acknowledge this alert")
        self.assertIn("__interrupt__", first)
        config = thread_config(self.principal, self.run_id)
        invalid = {"decision": "approved", "action_hash": "b" * 64,
                   "version": 1, "request_id": str(uuid4())}
        for attempt in range(MAX_APPROVAL_ATTEMPTS - 1):
            paused = graph.invoke(Command(resume=invalid), config=config)
            self.assertIn("__interrupt__", paused, f"attempt {attempt + 1} should allow one correction")
        with self.assertRaises(PolicyDenied):
            graph.invoke(Command(resume=invalid), config=config)


if __name__ == "__main__":
    unittest.main()
