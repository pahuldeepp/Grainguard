"""Disposable PostgresSaver acceptance for pause/resume and owner execution."""
from datetime import datetime, timedelta, timezone
import http.client
import json
from pathlib import Path
import subprocess
import time
from uuid import uuid4
from threading import Thread

import psycopg
from psycopg import sql

from advisor_security.policy import Principal
from advisor_security.proposals import propose
from advisor_security.http_api import create_server
from agent_workflow import WorkflowDependencies, build_workflow, postgres_checkpointer, resume, start, request_owner_token, start_existing_proposal
from migrate_security import apply as apply_migration


IMAGE = "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"


def run():
    name = "greenguard-advisor-workflow-" + str(uuid4())[:8]
    password = uuid4().hex

    def command(*args):
        return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL).strip()

    command(
        "docker", "run", "-d", "--name", name,
        "-e", "POSTGRES_USER=advisor_migrator",
        "-e", "POSTGRES_PASSWORD=" + password,
        "-e", "POSTGRES_DB=greenguard_advisor",
        "-p", "127.0.0.1::5432", IMAGE,
    )
    try:
        port = command("docker", "port", name, "5432/tcp").rsplit(":", 1)[1]
        admin = f"postgresql://advisor_migrator:{password}@127.0.0.1:{port}/greenguard_advisor"
        app = f"postgresql://advisor_app:{password}@127.0.0.1:{port}/greenguard_advisor"
        for _ in range(30):
            try:
                with psycopg.connect(admin, connect_timeout=1):
                    break
            except psycopg.OperationalError:
                time.sleep(0.5)
        else:
            raise RuntimeError("workflow Postgres did not become ready")
        with psycopg.connect(admin) as db:
            try:
                apply_migration(db)
            except ValueError:
                pass
            else:
                raise AssertionError("migration accepted missing runtime role")
            db.execute(sql.SQL("CREATE ROLE advisor_app LOGIN PASSWORD {} NOBYPASSRLS").format(sql.Literal(password)))
            apply_migration(db)
        tenant, user = str(uuid4()), str(uuid4())
        principal = Principal(
            tenant, user, "operator", "grain-advisor",
            datetime.now(timezone.utc) + timedelta(minutes=5),
        )
        run_id = str(uuid4())
        alert_id = str(uuid4())
        action_args = {"alert_id": alert_id, "note": "reviewed", "etag": '"v1"'}
        calls = []

        def planner(_principal, _question):
            return {"tool": "propose_acknowledge_alert", "args": action_args}

        def mcp_call(caller, tool, args):
            calls.append(("mcp", tool))
            with psycopg.connect(app) as db:
                return propose(db, caller, run_id, {"alert_id": args["alert_id"], "note": args["note"], "etag": args["etag"]})

        def token_provider(_principal):
            calls.append(("token",))
            return "Bearer " + ("o" * 48)

        def execute(_principal, action, owner_token, key):
            assert owner_token == "Bearer " + ("o" * 48)
            calls.append(("execute", action["target"], key))
            return {"status": 200, "owner": "fixture", "idempotency_key": key}

        deps = WorkflowDependencies(
            db=lambda: psycopg.connect(app),
            mcp_call=mcp_call,
            token_provider=token_provider,
            execute_action=execute,
            planner=planner,
        )

        with postgres_checkpointer(admin, setup=True):
            pass
        with psycopg.connect(admin) as checkpoint_admin:
            checkpoint_admin.execute("GRANT USAGE ON SCHEMA public TO advisor_app")
            for table in ("checkpoints", "checkpoint_blobs", "checkpoint_writes"):
                checkpoint_admin.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE {table} TO advisor_app")
            checkpoint_admin.execute("GRANT SELECT ON TABLE checkpoint_migrations TO advisor_app")

        with postgres_checkpointer(app) as saver:
            graph = build_workflow(deps, checkpointer=saver)
            pending = start(graph, principal, run_id, "acknowledge this alert")
            interrupt_value = pending["__interrupt__"][0].value
            proposal = interrupt_value["proposal"]
            assert proposal["action"]["target"] == alert_id
            assert calls == [("mcp", "propose_acknowledge_alert")]

        # Reopen the saver as a new worker would after a crash/restart.
        with postgres_checkpointer(app) as saver:
            graph = build_workflow(deps, checkpointer=saver)
            result = resume(graph, principal, run_id, {
                "decision": "approved",
                "action_hash": proposal["action_hash"],
                "version": proposal["version"],
                "request_id": str(uuid4()),
            })
            assert result["decision_result"]["execution_status"] == "succeeded"
        assert [call[0] for call in calls] == ["mcp", "token", "execute"]
        print("AGENT_WORKFLOW_PASS: PostgresSaver checkpoint survived worker restart; exact proposal interrupt, fresh owner token, ETag-bound execution and receipt persisted")

        # Exercise the actual Advisor HTTP proposal and approval routes. The
        # first route checkpoints on one saver/worker; approval resumes using a
        # newly opened saver to simulate a process restart between human turns.
        http_run, http_alert = str(uuid4()), str(uuid4())
        http_principal = Principal(tenant, str(uuid4()), "operator", "grain-advisor",
            datetime.now(timezone.utc) + timedelta(minutes=5))
        http_approver = Principal(tenant, str(uuid4()), "operator", "grain-advisor",
            datetime.now(timezone.utc) + timedelta(minutes=5))
        workflow_graph = {}
        http_calls = []

        def http_execute(caller, action, owner_token, key):
            assert caller.tenant_id == tenant
            assert owner_token == "Bearer " + ("x" * 48)
            http_calls.append((action["target"], key))
            return {"status": 200, "owner": "fixture", "idempotency_key": key}

        def http_deps():
            return WorkflowDependencies(db=lambda: psycopg.connect(app), mcp_call=mcp_call,
                token_provider=request_owner_token, execute_action=http_execute,
                planner=planner)

        class Verified:
            def verify(self, authorization, tenant_selector):
                if authorization not in {"Bearer signed-advisor", "Bearer signed-approver"} or tenant_selector != tenant:
                    raise ValueError("identity denied")
                return http_approver if authorization == "Bearer signed-approver" else http_principal

        def start_callback(caller, run, proposal):
            return start_existing_proposal(workflow_graph["graph"], caller, run, proposal)

        def resume_callback(caller, run, approval, owner_token):
            return resume(workflow_graph["graph"], caller, run, approval, owner_token,
                db=lambda: psycopg.connect(app), require_owner_token=True)

        server = None
        server_thread = None
        try:
            with postgres_checkpointer(app) as saver:
                workflow_graph["graph"] = build_workflow(http_deps(), checkpointer=saver)
                server = create_server(connect=lambda: psycopg.connect(app),
                    verifier=lambda _scope: Verified(),
                    authorize_alert=lambda caller, alert, etag: caller.tenant_id == tenant and alert == http_alert and etag == '"1"',
                    execute_action=http_execute, workflow_start=start_callback,
                    workflow_resume=resume_callback, host="127.0.0.1", port=0)
                server_thread = Thread(target=server.serve_forever, daemon=True); server_thread.start()
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("GET", "/healthz")
                health = connection.getresponse(); health_body = json.loads(health.read()); connection.close()
                assert health.status == 200 and health_body == {"status": "ok"}
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                body = json.dumps({"run_id": http_run, "alert_id": http_alert, "note": "reviewed", "etag": '"1"'})
                connection.request("POST", "/v1/advisor/proposals", body=body, headers={
                    "Authorization": "Bearer signed-advisor", "X-Tenant-ID": tenant,
                    "Content-Type": "application/json"})
                response = connection.getresponse(); proposal = json.loads(response.read()); connection.close()
                assert response.status == 201 and proposal["status"] == "pending"
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("POST", f"/v1/advisor/proposals/{proposal['proposal_id']}/decision",
                    body=json.dumps({"decision": "approved", "action_hash": "0" * 64, "version": 1}),
                    headers={"Authorization": "Bearer signed-advisor", "X-Tenant-ID": tenant,
                        "Content-Type": "application/json", "If-Match": '"1"',
                        "Idempotency-Key": str(uuid4()), "X-Owner-Delegated-Token": "Bearer " + ("x" * 48)})
                stale_response = connection.getresponse(); stale_response.read(); connection.close()
                assert stale_response.status == 409
                snapshot = workflow_graph["graph"].get_state({"configurable": {
                    "thread_id": f"{tenant}:proposal:{proposal['proposal_id']}"}})
                assert snapshot.tasks and snapshot.tasks[0].interrupts

            with postgres_checkpointer(app) as saver:
                workflow_graph["graph"] = build_workflow(http_deps(), checkpointer=saver)
                decision_request_id = str(uuid4())
                decision_body = json.dumps({"decision": "approved", "action_hash": proposal["action_hash"], "version": 1})
                decision_headers = {"Authorization": "Bearer signed-approver", "X-Tenant-ID": tenant,
                    "Content-Type": "application/json", "If-Match": '"1"',
                    "Idempotency-Key": decision_request_id, "X-Owner-Delegated-Token": "Bearer " + ("x" * 48)}
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("POST", f"/v1/advisor/proposals/{proposal['proposal_id']}/decision",
                    body=decision_body, headers=decision_headers)
                response = connection.getresponse(); result = json.loads(response.read()); connection.close()
                assert response.status == 200 and result["execution_status"] == "succeeded"
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("POST", f"/v1/advisor/proposals/{proposal['proposal_id']}/decision",
                    body=decision_body, headers=decision_headers)
                duplicate_response = connection.getresponse(); duplicate = json.loads(duplicate_response.read()); connection.close()
                assert duplicate_response.status == 200 and duplicate["execution_receipt"] == result["execution_receipt"]

                # A preexisting DB proposal with no checkpoint remains
                # approvable if workflows were enabled later or checkpointing
                # failed after the proposal transaction committed.
                with psycopg.connect(app) as db:
                    orphan = propose(db, http_principal, str(uuid4()),
                        {"alert_id": http_alert, "note": "reviewed", "etag": '"1"'})
                reject_headers = {"Authorization": "Bearer signed-approver", "X-Tenant-ID": tenant,
                    "Content-Type": "application/json", "If-Match": '"1"',
                    "Idempotency-Key": str(uuid4())}
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("POST", f"/v1/advisor/proposals/{orphan['proposal_id']}/decision",
                    body=json.dumps({"decision": "rejected", "action_hash": orphan["action_hash"], "version": 1}),
                    headers=reject_headers)
                orphan_response = connection.getresponse(); orphan_result = json.loads(orphan_response.read()); connection.close()
                assert orphan_response.status == 200 and orphan_result["status"] == "rejected"
            assert http_calls and http_calls[0][0] == http_alert
            assert len(http_calls) == 1
            print("ADVISOR_HTTP_WORKFLOW_PASS: HTTP proposal paused in PostgresSaver; different authorized operator resumed after worker restart; missing-checkpoint proposal used safe legacy decision path; owner execution remained one-time")
        finally:
            if server is not None:
                server.shutdown(); server.server_close()
            if server_thread is not None:
                server_thread.join(timeout=3)
    finally:
        command("docker", "rm", "-f", name)


if __name__ == "__main__":
    run()
