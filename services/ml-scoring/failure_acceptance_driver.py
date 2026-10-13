"""Test-only launcher: deterministic abrupt crashes at actual runtime boundaries.

Invoked only by failure_acceptance.py against its newly created local resources.
There are no fault-injection switches in the service runtime.
"""
from __future__ import annotations

import json
import os
import signal
from pathlib import Path
import sys

from ml_scoring import main, store
from ml_scoring.processor import ShadowScoringProcessor

INPUT_CRASH = 73
OUTPUT_CRASH = 74


def record(path: Path, body: dict) -> None:
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(body, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def run(mode: str, journal: Path, crash_event_id: str = "") -> None:
    if os.environ.get("ML_FAILURE_ACCEPTANCE_DRIVER") != "disposable-local-only":
        raise RuntimeError("fault launcher requires disposable acceptance opt-in")
    main.validate_local_endpoints(os.environ["ML_DATABASE_URL"],
                                  os.environ["KAFKA_BOOTSTRAP_SERVERS"])
    process = ShadowScoringProcessor.process

    def traced_process(self, topic, key, raw, *, partition, offset):
        result = process(self, topic, key, raw, partition=partition, offset=offset)
        record(journal, {"boundary": "database_committed", "status": result.status,
                         "event_id": json.loads(raw)["event_id"],
                         "partition": partition, "offset": offset})
        return result

    ShadowScoringProcessor.process = traced_process
    if mode == "input-crash":
        commit = main.commit_offset_after_processing

        def crash_before_input_commit(consumer, message):
            if json.loads(message.value())["event_id"] == crash_event_id:
                record(journal, {"boundary": "before_input_offset_commit",
                                 "event_id": crash_event_id, "offset": message.offset()})
                os._exit(INPUT_CRASH)
            return commit(consumer, message)

        main.commit_offset_after_processing = crash_before_input_commit
    elif mode == "output-crash":
        def crash_before_output_mark(self, event_id, lease_token):
            # Called by the real relay only after a successful delivery callback
            # and flush. Its transaction will roll back when this process exits.
            record(journal, {"boundary": "after_output_ack_before_database_mark",
                             "event_id": event_id})
            os._exit(OUTPUT_CRASH)

        store._PostgresTransaction.mark_shadow_event_published = crash_before_output_mark
    elif mode != "observe":
        raise ValueError("unknown acceptance driver mode")
    main.run()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: main.STOP.set())
    signal.signal(signal.SIGINT, lambda *_: main.STOP.set())
    run(sys.argv[1], Path(sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else "")
