"""Offline ownership regressions; all Docker/sleep calls use temporary fixtures."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SOURCE_ID = "a" * 64
TARGET_ID = "b" * 64
SCRIPT = Path(__file__).with_name("stage12-postgres-restore.sh")
FAKE_DOCKER = r'''
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
mode = os.environ["RESTORE_FIXTURE_MODE"]
state_path = Path(os.environ["RESTORE_FIXTURE_STATE"])
state = json.loads(state_path.read_text())
with open(os.environ["RESTORE_FIXTURE_TRACE"], "a") as trace:
    trace.write(json.dumps(args) + "\n")
if args[:2] == ["image", "inspect"]:
    sys.exit(1 if mode == "missing-image" else 0)
if args[0] == "run":
    name = args[args.index("--name") + 1]
    source = "-source-" in name
    if (source and mode == "source-collision") or (not source and mode == "target-collision"):
        state[name] = "preexisting-container-id"
        state_path.write_text(json.dumps(state))
        print("Conflict: container name already in use", file=sys.stderr)
        sys.exit(125)
    container_id = ("a" if source else "b") * 64
    state[name] = container_id
    state_path.write_text(json.dumps(state))
    print(container_id)
elif args[0] == "rm":
    for identifier in args[2:]:
        state = {name: value for name, value in state.items()
                 if name != identifier and value != identifier}
    state_path.write_text(json.dumps(state))
elif args[0] == "cp":
    Path(args[-1]).write_text("synthetic dump")
elif args[0] == "exec":
    if "pg_isready" in args:
        sys.exit(1 if mode == "readiness-failure" else 0)
    if mode == "failure-after-source":
        sys.exit(1)
    if "-qAt" in args:
        print("tenant-a:2\ntenant-b:1\ncross-tenant:0")
'''


class RestoreCleanupOwnership(unittest.TestCase):
    def run_fixture(self, mode, expected_exit, expected_removed, collision=False):
        with tempfile.TemporaryDirectory(prefix="stage12-restore-ownership-") as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            (root / "work").mkdir()
            (root / "bin").mkdir()
            script = root / "scripts" / SCRIPT.name
            shutil.copyfile(SCRIPT, script)
            docker = root / "bin" / "docker"
            docker.write_text(f"#!{sys.executable}\n" + FAKE_DOCKER)
            docker.chmod(0o755)
            sleep = root / "bin" / "sleep"
            sleep.write_text("#!/bin/sh\nexit 0\n")
            sleep.chmod(0o755)
            state = root / "state.json"
            state.write_text("{}")
            trace = root / "trace.jsonl"
            env = os.environ.copy()
            env.update(
                PATH=str(root / "bin") + os.pathsep + env.get("PATH", ""),
                RESTORE_FIXTURE_MODE=mode,
                RESTORE_FIXTURE_STATE=str(state),
                RESTORE_FIXTURE_TRACE=str(trace),
            )
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True,
                timeout=20,
            )
            self.assertEqual(result.returncode, expected_exit, result.stderr)
            calls = [json.loads(line) for line in trace.read_text().splitlines()]
            removals = [call for call in calls if call[0] == "rm"]
            expected = [["rm", "-fv", *expected_removed]] if expected_removed else []
            self.assertEqual(removals, expected, calls)
            remaining = json.loads(state.read_text())
            if collision:
                self.assertEqual(list(remaining.values()), ["preexisting-container-id"])
            else:
                self.assertEqual(remaining, {})
            self.assertEqual(list((root / "work").iterdir()), [])

    def test_missing_image_removes_no_container(self):
        self.run_fixture("missing-image", 2, [])

    def test_source_name_collision_preserves_existing_container(self):
        self.run_fixture("source-collision", 1, [], collision=True)

    def test_failure_after_source_removes_only_created_source_id(self):
        self.run_fixture("failure-after-source", 1, [SOURCE_ID])

    def test_readiness_failure_removes_created_source_id(self):
        self.run_fixture("readiness-failure", 1, [SOURCE_ID])

    def test_target_name_collision_preserves_existing_container(self):
        self.run_fixture("target-collision", 1, [SOURCE_ID], collision=True)

    def test_success_removes_both_created_ids_and_volumes(self):
        self.run_fixture("success", 0, [SOURCE_ID, TARGET_ID])


if __name__ == "__main__":
    unittest.main(verbosity=2)
