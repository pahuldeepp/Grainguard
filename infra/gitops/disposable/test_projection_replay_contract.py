"""Sharded replay remains an explicit operator-only, fail-closed capability."""

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).parent
REPO = ROOT.parents[2]


class ProjectionReplayContractTests(unittest.TestCase):
    def test_stage12_deployment_does_not_advertise_replay_as_a_workload(self):
        contract = json.loads((ROOT / "contract.json").read_text())
        self.assertNotIn("projection-replay", {release["name"] for release in contract["releases"]})
        inventory = (ROOT / "runtime-process-inventory.md").read_text()
        self.assertIn("not a deployed release or part of the Stage 12 live acceptance contract", inventory)
        self.assertIn("no fixed-primary fallback", inventory)

    def test_shard_registry_path_is_rejected_before_replay_execution(self):
        source = (REPO / "services/projection-builder/replay.go").read_text()
        marker = 'if getenv("SHARD_REGISTRY_FILE") != "" {'
        self.assertIn(marker, source)
        start = source.index(marker, source.index("func replayMain("))
        guard_end = source.index("\n\t}", start) + len("\n\t}")
        guard = source[start:guard_end]
        self.assertIn("sharded operational replay requires an explicit shard migration/replay protocol", guard)
        self.assertNotIn("runReplay(", guard)
        self.assertIn("TestReplayMainRejectsShardedModeBeforeOpeningAnyDependencies", (REPO / "services/projection-builder/replay_test.go").read_text())


if __name__ == "__main__":
    unittest.main()
